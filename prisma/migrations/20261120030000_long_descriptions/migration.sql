-- Uraian item boleh panjang (BQ, RAP, PR, PO, RFQ, VO)
-- AlterTable
ALTER TABLE `BqItem` MODIFY `section` VARCHAR(500) NOT NULL,
    MODIFY `description` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `BudgetItem` MODIFY `description` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `PurchaseOrderItem` MODIFY `description` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `PurchaseRequestItem` MODIFY `description` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `RfqItem` MODIFY `description` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `TenderItem` MODIFY `section` VARCHAR(500) NOT NULL,
    MODIFY `description` TEXT NOT NULL;

-- AlterTable
ALTER TABLE `VariationOrderItem` MODIFY `description` TEXT NOT NULL;

