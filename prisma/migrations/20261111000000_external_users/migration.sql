-- Akun dari sistem eksternal (SuperApps)
ALTER TABLE `User` ADD COLUMN `externalSource` VARCHAR(191) NULL,
    ADD COLUMN `externalId` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `User_tenantId_externalSource_externalId_key` ON `User`(`tenantId`, `externalSource`, `externalId`);
