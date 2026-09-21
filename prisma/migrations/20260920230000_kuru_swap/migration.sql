-- A hunter's Kuru trades, as the chain describes them.
--
-- Before this, a spot trade lived in React state and was gone on reload. The
-- screen claims trades run on Kuru's order book; without a record there was no
-- way to check that claim after the fact, and the first real spot trade in
-- production turned out to have routed through Uniswap pools instead.
--
-- Wei is TEXT, not BIGINT. Postgres BIGINT stops near 9.22e18 and a 10 MON
-- trade is 1e19, so an ordinary trade would overflow a numeric column.
CREATE TABLE "KuruSwap" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "gasWei" TEXT NOT NULL,
    "valueWei" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "tokensIn" JSONB NOT NULL,
    "crossedOrderBook" BOOLEAN NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KuruSwap_pkey" PRIMARY KEY ("id")
);

-- Unique so a retry or a double-tap records one row rather than two.
CREATE UNIQUE INDEX "KuruSwap_hash_key" ON "KuruSwap"("hash");
CREATE INDEX "KuruSwap_wallet_at_idx" ON "KuruSwap"("wallet", "at");
