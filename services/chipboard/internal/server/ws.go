package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/auth"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/engine"
)

const (
	sendBuffer  = 64
	maxBatch    = 16 // most messages put into one frame
	authTimeout = 5 * time.Second
	maxMsgBytes = 2048
	// A client that keeps sending past its rate limit is cut off.
	maxConsecutiveLimited = 200

	closeReplaced = websocket.StatusCode(4001) // a newer connection for the same player took over
	closeSlow     = websocket.StatusCode(4002) // the client was not reading
	closeAuth     = websocket.StatusCode(4003) // no valid auth message in time
	closeAbuse    = websocket.StatusCode(4004) // rate limit ignored
	closeShutdown = websocket.StatusCode(4000)
)

// Server -> client frames are text frames holding one or more JSON messages,
// one per line ("\n" between them). Client -> server frames hold one message.
//
// inMsg is every client -> server message.
//
//	{"t":"auth","token":"playerId.expiry.signature"}   first message, within 5 s
//	{"t":"auth","player":"name"}                       only with DEV_ANON=1
//	{"t":"set","id":1,"round":88123456,"chips":[12 ints, sum <= 100]}
//	{"t":"add","id":2,"round":88123456,"band":6,"delta":10}
type inMsg struct {
	T      string `json:"t"`
	ID     int64  `json:"id"`
	Round  int64  `json:"round"`
	Chips  []int  `json:"chips"`
	Band   *int   `json:"band"`
	Delta  int    `json:"delta"`
	Token  string `json:"token"`
	Player string `json:"player"`
}

type client struct {
	hub    *Hub
	player string
	ws     *websocket.Conn
	send   chan outMsg
	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once
	shard  int // which slice of the price-tick cycle this client is in
}

// outMsg is one queued frame. readAt is set on a reply to a client message:
// when that message was read, so the time to its reply can be measured.
type outMsg struct {
	b      []byte
	readAt time.Time
}

// ackBucketsMs are the upper bounds of the reply-time histogram in /metrics.
var ackBucketsMs = [...]int64{1, 2, 5, 10, 25, 50, 100, 250, 500, 1000}

// enqueue queues a message the client must get. A client whose queue is full
// is not reading; it is dropped rather than allowed to hold the round up.
func (c *client) enqueue(b []byte) { c.enqueueReply(b, time.Time{}) }

func (c *client) enqueueReply(b []byte, readAt time.Time) {
	select {
	case c.send <- outMsg{b, readAt}:
	default:
		c.hub.inc("dropped_slow_consumers", 1)
		c.drop(closeSlow, "too slow")
	}
}

// enqueueDroppable queues a price tick, or skips it if the client is behind.
func (c *client) enqueueDroppable(b []byte) {
	if len(c.send) > cap(c.send)/2 {
		c.hub.inc("px_skipped", 1)
		return
	}
	select {
	case c.send <- outMsg{b: b}:
	default:
	}
}

// drop closes the connection with a close code the client can read.
func (c *client) drop(code websocket.StatusCode, reason string) {
	c.once.Do(func() {
		go func() {
			c.ws.Close(code, reason)
			c.cancel()
		}()
	})
}

// writer sends queued messages. Everything waiting in the queue goes out in
// one WebSocket text frame, one JSON message per line, so a client that is
// briefly behind (or the burst at a round boundary) costs one write, not five.
func (c *client) writer() {
	var buf []byte
	for {
		select {
		case <-c.ctx.Done():
			return
		case m := <-c.send:
			buf = append(buf[:0], m.b...)
			n := 1
			var readAt [maxBatch]time.Time
			readAt[0] = m.readAt
		drain:
			for n < maxBatch {
				select {
				case m = <-c.send:
					buf = append(append(buf, '\n'), m.b...)
					readAt[n] = m.readAt
					n++
				default:
					break drain
				}
			}
			// No per-write deadline: a client that stops reading fills its
			// queue and is dropped by enqueue, which also unblocks this write.
			if err := c.ws.Write(c.ctx, websocket.MessageText, buf); err != nil {
				c.cancel()
				return
			}
			c.hub.msgsOut.Add(int64(n))
			c.hub.framesOut.Add(1)
			for _, t := range readAt[:n] {
				if !t.IsZero() {
					c.hub.observeAck(time.Since(t))
				}
			}
		}
	}
}

// authenticate reads the first message and returns the player it proves.
// Tokens are never logged.
func (h *Hub) authenticate(ctx context.Context, ws *websocket.Conn) (string, bool) {
	actx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()
	_, data, err := ws.Read(actx)
	if err != nil {
		return "", false
	}
	var m inMsg
	if json.Unmarshal(data, &m) != nil || m.T != "auth" {
		return "", false
	}
	if m.Token != "" {
		if h.verifier == nil {
			return "", false
		}
		id, err := h.verifier.Verify(m.Token, h.now())
		if err != nil {
			return "", false
		}
		return id, true
	}
	if !h.cfg.DevAnon {
		return "", false
	}
	// Anonymous ids live under their own prefix so they can never collide
	// with a signed player id.
	name := m.Player
	if name == "" {
		var b [6]byte
		rand.Read(b[:])
		name = hex.EncodeToString(b[:])
	}
	id := "anon-" + name
	if !auth.ValidPlayerID(id) {
		return "", false
	}
	return id, true
}

// ServeWS is the /ws endpoint.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	if int(h.nConns.Load()) >= h.cfg.MaxConns {
		h.inc("refused_max_conns", 1)
		http.Error(w, "server full", http.StatusServiceUnavailable)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: h.cfg.AllowedOrigins})
	if err != nil {
		h.inc("ws_accept_errors", 1)
		return
	}
	defer ws.CloseNow()
	ws.SetReadLimit(maxMsgBytes)
	h.nConns.Add(1)
	defer h.nConns.Add(-1)

	player, ok := h.authenticate(r.Context(), ws)
	if !ok {
		h.inc("auth_failed", 1)
		ws.Close(closeAuth, "unauthorized")
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	c := &client{hub: h, player: player, ws: ws, send: make(chan outMsg, sendBuffer), ctx: ctx, cancel: cancel}

	// One live connection per player: the newest wins.
	h.mu.Lock()
	if old := h.conns[player]; old != nil {
		h.inc("replaced_connections", 1)
		old.drop(closeReplaced, "replaced by a newer connection")
	}
	h.conns[player] = c
	h.shardSeq++
	c.shard = h.shardSeq % pxShards
	c.enqueue(h.helloLocked(player))
	h.mu.Unlock()
	h.inc("connections_total", 1)
	defer func() {
		h.mu.Lock()
		if h.conns[player] == c {
			delete(h.conns, player)
		}
		h.mu.Unlock()
	}()

	go c.writer()

	tokens, last, limited := float64(h.cfg.RateBurst), time.Now(), 0
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		readAt := time.Now()
		h.msgsIn.Add(1)
		var m inMsg
		if json.Unmarshal(data, &m) != nil {
			h.inc("refused_"+ReasonBadMessage, 1)
			c.enqueue(mustJSON(map[string]any{"t": "ack", "ok": false, "reason": ReasonBadMessage}))
			continue
		}
		// Token bucket: RatePerSec refills, RateBurst is the most it holds.
		nowT := readAt
		tokens += nowT.Sub(last).Seconds() * h.cfg.RatePerSec
		if max := float64(h.cfg.RateBurst); tokens > max {
			tokens = max
		}
		last = nowT
		if tokens < 1 {
			limited++
			h.inc("refused_"+ReasonRateLimited, 1)
			if limited > maxConsecutiveLimited {
				c.drop(closeAbuse, "rate limit")
				return
			}
			c.enqueue(mustJSON(map[string]any{"t": "ack", "id": m.ID, "ok": false, "reason": ReasonRateLimited, "round": m.Round}))
			continue
		}
		tokens--
		limited = 0

		if m.T == "ping" {
			c.enqueue(mustJSON(map[string]any{"t": "pong", "id": m.ID, "ts": h.nowMs()}))
			continue
		}
		chips, now, reason := h.place(player, &m)
		if reason != "" {
			h.inc("refused_"+reason, 1)
			c.enqueueReply(mustJSON(map[string]any{"t": "ack", "id": m.ID, "ok": false, "reason": reason, "round": m.Round, "ts": now}), readAt)
			continue
		}
		h.inc("placements_accepted", 1)
		c.enqueueReply(mustJSON(map[string]any{"t": "ack", "id": m.ID, "ok": true, "round": m.Round, "chips": chips, "left": engine.ChipsPerRound - engine.Sum(chips), "ts": now}), readAt)
	}
}
