// Package feed fills a price.Book: from the five public market-data sockets
// (FEED=live) or from a seeded random walk (FEED=synthetic). Read-only public
// data; no keys.
//
// Message formats are the ones verified in cota-lag/recorder.js.
package feed

import (
	"encoding/json"
	"strconv"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
)

// Perpl BTC is market 1; prices are scaled by 10 (648785 = $64,878.5).
const (
	perplBTCMarket  = "1"
	perplPriceScale = 10.0
)

// Tick is one price from one source. T is the local receive time, except for
// Perpl snapshot trades, which carry Perpl's own trade time.
type Tick struct {
	Src price.Source
	T   int64
	P   float64
}

// encoding/json matches keys without regard to case, and these feeds use keys
// that differ only by case (Binance sends both "e" and "E", "t" and "T"). So
// every message is opened as a map, whose keys are exact.
type obj = map[string]json.RawMessage

func asObj(raw []byte) obj {
	var m obj
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

func asList(raw []byte) []obj {
	var l []obj
	if json.Unmarshal(raw, &l) != nil {
		return nil
	}
	return l
}

// number reads a JSON number, or a number sent as a string; 0 if it is neither.
func number(raw json.RawMessage) float64 {
	if len(raw) == 0 {
		return 0
	}
	var s string
	if raw[0] == '"' {
		if json.Unmarshal(raw, &s) != nil {
			return 0
		}
	} else {
		s = string(raw)
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return f
}

func text(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// parsePerpl handles trades (mt 18 live, mt 17 snapshot) and market-state (mt 9).
func parsePerpl(msg []byte, r int64) []Tick {
	m := asObj(msg)
	switch int(number(m["mt"])) {
	case 9: // mark price (an index, not a fill) for every market; keep BTC
		st := asObj(asObj(m["d"])[perplBTCMarket])
		if mrk := number(st["mrk"]); mrk > 0 {
			return []Tick{{price.PerplMark, r, mrk / perplPriceScale}}
		}
	case 17, 18:
		snapshot := int(number(m["mt"])) == 17
		var out []Tick
		for _, t := range asList(m["d"]) {
			p := number(t["p"])
			if !(p > 0) {
				continue
			}
			at := r
			if snapshot {
				// A snapshot replays trades that happened before we connected.
				// Stamp them with Perpl's trade time so they do not look fresh.
				x := int64(number(asObj(t["at"])["t"]))
				if x <= 0 || x > r {
					continue
				}
				at = x
			}
			out = append(out, Tick{price.Perpl, at, p / perplPriceScale})
		}
		return out
	}
	return nil
}

func parseBinance(msg []byte, r int64) []Tick {
	m := asObj(msg)
	if text(m["e"]) != "trade" {
		return nil
	}
	return []Tick{{price.Binance, r, number(m["p"])}}
}

func parseOKX(msg []byte, r int64) []Tick {
	var out []Tick
	for _, t := range asList(asObj(msg)["data"]) {
		out = append(out, Tick{price.OKX, r, number(t["px"])})
	}
	return out
}

func parseBybit(msg []byte, r int64) []Tick {
	m := asObj(msg)
	if text(m["topic"]) != "publicTrade.BTCUSDT" {
		return nil
	}
	var out []Tick
	for _, t := range asList(m["data"]) {
		out = append(out, Tick{price.Bybit, r, number(t["p"])})
	}
	return out
}

func parseCoinbase(msg []byte, r int64) []Tick {
	m := asObj(msg)
	if text(m["type"]) != "match" {
		return nil
	}
	return []Tick{{price.Coinbase, r, number(m["price"])}}
}

type spec struct {
	name  string
	url   string
	sub   string
	ping  string
	parse func(msg []byte, r int64) []Tick
}

const pingEvery = 20 * time.Second

var liveSpecs = []spec{
	{
		name: "perpl", url: "wss://app.perpl.xyz/ws/v1/market-data",
		sub:   `{"mt":5,"subs":[{"stream":"trades@1","subscribe":true},{"stream":"heartbeat@143","subscribe":true},{"stream":"market-state@143","subscribe":true}]}`,
		parse: parsePerpl,
	},
	{name: "binance", url: "wss://stream.binance.com:9443/ws/btcusdt@trade", parse: parseBinance},
	{
		name: "okx", url: "wss://ws.okx.com:8443/ws/v5/public",
		sub:  `{"op":"subscribe","args":[{"channel":"trades","instId":"BTC-USDT-SWAP"}]}`,
		ping: "ping", parse: parseOKX,
	},
	{
		name: "bybit", url: "wss://stream.bybit.com/v5/public/linear",
		sub:  `{"op":"subscribe","args":["publicTrade.BTCUSDT"]}`,
		ping: `{"op":"ping"}`, parse: parseBybit,
	},
	{
		name: "coinbase", url: "wss://ws-feed.exchange.coinbase.com",
		sub:   `{"type":"subscribe","product_ids":["BTC-USD"],"channels":["matches"]}`,
		parse: parseCoinbase,
	},
}
