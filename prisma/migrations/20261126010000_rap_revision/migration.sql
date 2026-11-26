-- Revisi RAP setelah ditetapkan
ALTER TABLE `Budget`
  ADD COLUMN `revisionNote` TEXT NULL,
  ADD COLUMN `createdBy` CHAR(36) NULL,
  ADD COLUMN `approvedBy` CHAR(36) NULL;
