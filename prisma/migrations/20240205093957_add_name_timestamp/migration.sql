/*
  Warnings:

  - Added the required column `timestamp` to the `Names` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Names" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL
);
INSERT INTO "new_Names" ("id", "name", "npub") SELECT "id", "name", "npub" FROM "Names";
DROP TABLE "Names";
ALTER TABLE "new_Names" RENAME TO "Names";
CREATE UNIQUE INDEX "Names_name_key" ON "Names"("name");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
