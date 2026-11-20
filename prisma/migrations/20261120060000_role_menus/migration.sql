-- Menu per role (null = semua menu sesuai permission)
ALTER TABLE `Role` ADD COLUMN `menus` JSON NULL;
