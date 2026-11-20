-- RAP disusun seperti RAB (acuan baris RAB, bagian, kode, urutan)
-- AlterTable
ALTER TABLE `BqItem` ADD COLUMN `estUnitCost` DECIMAL(20, 6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `BudgetItem` ADD COLUMN `bqItemId` CHAR(36) NULL,
    ADD COLUMN `code` VARCHAR(191) NULL,
    ADD COLUMN `section` VARCHAR(500) NULL,
    ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

