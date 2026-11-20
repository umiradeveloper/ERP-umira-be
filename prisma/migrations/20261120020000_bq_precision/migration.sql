-- Presisi volume & harga satuan BQ/RAP disamakan dengan Excel (6 desimal)
-- AlterTable
ALTER TABLE `BqItem` MODIFY `quantity` DECIMAL(20, 6) NOT NULL DEFAULT 0,
    MODIFY `unitPrice` DECIMAL(20, 6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `BudgetItem` MODIFY `quantity` DECIMAL(20, 6) NOT NULL DEFAULT 0,
    MODIFY `unitRate` DECIMAL(20, 6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `TenderItem` MODIFY `quantity` DECIMAL(20, 6) NOT NULL DEFAULT 0,
    MODIFY `unitCost` DECIMAL(20, 6) NOT NULL DEFAULT 0;

