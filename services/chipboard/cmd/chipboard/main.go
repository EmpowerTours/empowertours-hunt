// chipboard is the Cota Chip Board game server.
//
// Environment:
//
//	PORT                      listen port (default 8090)
//	FEED                      live | synthetic (default live)
//	SYNTH_SEED                seed for FEED=synthetic (default 1)
//	SETTLE_PRICE              perpl_last | perpl_twap30 | perpl_mark | composite (default composite)
//	VOID_PERPL_STALE_S        void when Perpl's price is older than this (default 30)
//	VOID_DIVERGENCE_BPS       void when the chosen price is this far from the composite (default 8)
//	SIGMA_MIN_SAMPLES         1-second samples needed before a round opens (default 60)
//	QUALIFY_ROUNDS            rounds in a day to qualify for prizes (default 20)
//	EVENT_LOG_DIR             where the JSONL event log goes (default ./eventlog)
//	CHIPBOARD_SESSION_SECRET  shared secret for session tokens (at least 32 characters)
//	DEV_ANON                  1 = accept anonymous players (local testing only)
//	ALLOWED_ORIGINS           comma-separated browser origin hosts allowed on /ws
//	RATE_MSGS_PER_S           client messages per second per connection (default 20)
//	RATE_BURST                burst on top of that (default 40)
//	MAX_CONNS                 connection cap (default 20000)
//	PPROF                     1 = serve /debug/pprof for CPU profiling (default off)
//	PX_HZ                     price ticks per second to each client, 1-4 (default 4)
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/auth"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/eventlog"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/feed"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/price"
	"github.com/EmpowerTours/empowertours-hunt/services/chipboard/internal/server"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envNum(key string, def float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		log.Fatalf("%s must be a non-negative number", key)
	}
	return f
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds | log.LUTC)

	pcfg := price.DefaultConfig()
	pcfg.PerplStaleMs = int64(envNum("VOID_PERPL_STALE_S", 30) * 1000)
	pcfg.DivergenceBps = envNum("VOID_DIVERGENCE_BPS", 8)
	book := price.NewBook(pcfg)

	cfg := server.DefaultConfig()
	cfg.Rule = env("SETTLE_PRICE", price.RuleComposite)
	cfg.SigmaMinSamples = int(envNum("SIGMA_MIN_SAMPLES", 60))
	cfg.QualifyRounds = int(envNum("QUALIFY_ROUNDS", 20))
	cfg.RatePerSec = envNum("RATE_MSGS_PER_S", 20)
	cfg.RateBurst = int(envNum("RATE_BURST", 40))
	cfg.MaxConns = int(envNum("MAX_CONNS", 20000))
	cfg.PxPerSec = int(envNum("PX_HZ", 4))
	cfg.DevAnon = os.Getenv("DEV_ANON") == "1"
	cfg.Pprof = os.Getenv("PPROF") == "1"
	cfg.FeedMode = env("FEED", "live")
	if o := os.Getenv("ALLOWED_ORIGINS"); o != "" {
		for _, s := range strings.Split(o, ",") {
			if s = strings.TrimSpace(s); s != "" {
				cfg.AllowedOrigins = append(cfg.AllowedOrigins, s)
			}
		}
	}

	// Auth fails closed: with neither a secret nor DEV_ANON nobody could
	// connect, so refuse to start rather than run a server that looks alive.
	var verifier auth.Verifier
	if secret := os.Getenv("CHIPBOARD_SESSION_SECRET"); secret != "" {
		v, err := auth.NewHMAC(secret)
		if err != nil {
			log.Fatalf("CHIPBOARD_SESSION_SECRET: %v", err)
		}
		verifier = v
	} else if !cfg.DevAnon {
		log.Fatal("set CHIPBOARD_SESSION_SECRET (or DEV_ANON=1 for local testing)")
	}

	var fd feed.Feed
	switch cfg.FeedMode {
	case "live":
		fd = feed.NewLive(book, log.Printf)
	case "synthetic":
		fd = feed.NewSynthFeed(book, int64(envNum("SYNTH_SEED", 1)), time.Now().UnixMilli())
	default:
		log.Fatalf("FEED must be live or synthetic, got %q", cfg.FeedMode)
	}

	logDir := env("EVENT_LOG_DIR", "./eventlog")
	elog, err := eventlog.Open(logDir)
	if err != nil {
		log.Fatalf("event log: %v", err)
	}

	hub, err := server.NewHub(cfg, server.Deps{Book: book, Feed: fd, Log: elog, Verifier: verifier, Logf: log.Printf, Fatalf: log.Fatalf})
	if err != nil {
		log.Fatal(err)
	}
	if err := hub.Boot(logDir); err != nil {
		log.Fatalf("boot: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go fd.Run(ctx)
	go hub.Run(ctx)

	srv := &http.Server{Addr: ":" + env("PORT", "8090"), Handler: hub.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	log.Printf("chipboard listening on %s · feed=%s · settle=%s · anon=%v · tokens=%v · event log %s",
		srv.Addr, cfg.FeedMode, cfg.Rule, cfg.DevAnon, verifier != nil, logDir)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	hub.Shutdown()
	log.Print("chipboard stopped")
}
