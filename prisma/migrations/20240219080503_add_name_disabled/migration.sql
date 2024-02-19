-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Names" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "npub" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "disabled" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_Names" ("id", "name", "npub", "timestamp") SELECT "id", "name", "npub", "timestamp" FROM "Names";
DROP TABLE "Names";
ALTER TABLE "new_Names" RENAME TO "Names";
CREATE UNIQUE INDEX "Names_name_key" ON "Names"("name");
CREATE INDEX "Names_npub_idx" ON "Names"("npub");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
