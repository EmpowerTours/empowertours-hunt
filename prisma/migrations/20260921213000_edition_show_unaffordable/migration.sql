-- Showing a work the hunter cannot afford yet, rather than showing nothing.
--
-- The affordability filter emptied the placeable pool on the live hunt: a
-- 24.45 MON wallet against a catalogue whose cheapest unheld offer is 35, so
-- seven works became `catalogue_exhausted`. Default TRUE keeps every existing
-- hunt exactly as it was.
--
-- This is not a money gate. The hunter signs from their own wallet, so an
-- unaffordable purchase fails at signing with nothing moved. The gate that
-- protects real money is the relayer-capacity filter, which is unconditional.
ALTER TABLE "Hunt"
  ADD COLUMN "editionRequireAffordable" BOOLEAN NOT NULL DEFAULT true;
