-- BK/PU penetapan (manual) dan foto proyek
ALTER TABLE `Project` ADD COLUMN `bkpuPenetapanPct` DECIMAL(7, 2) NULL,
    ADD COLUMN `coverFileId` CHAR(36) NULL;
