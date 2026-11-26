-- Progres dalam Rupiah (nilai prestasi kumulatif) terhadap total RAB
ALTER TABLE `ProgressEntry`
  ADD COLUMN `plannedValue` DECIMAL(20, 2) NULL,
  ADD COLUMN `actualValue` DECIMAL(20, 2) NULL,
  ADD COLUMN `baseValue` DECIMAL(20, 2) NULL;
