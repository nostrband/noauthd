/*
  Warnings:

  - You are about to alter the column `timestamp` on the `NpubData` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.
  - You are about to alter the column `timestamp` on the `PushSubs` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_NpubData" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" BIGINT NOT NULL,
    "npub" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "pwh2" TEXT NOT NULL,
    "salt" TEXT NOT NULL
);
INSERT INTO "new_NpubData" ("data", "id", "npub", "pwh2", "salt", "timestamp") SELECT "data", "id", "npub", "pwh2", "salt", "timestamp" FROM "NpubData";
DROP TABLE "NpubData";
ALTER TABLE "new_NpubData" RENAME TO "NpubData";
CREATE UNIQUE INDEX "NpubData_npub_key" ON "NpubData"("npub");
CREATE TABLE "new_PushSubs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pushId" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "npub" TEXT NOT NULL,
    "pushSubscription" TEXT NOT NULL,
    "relays" TEXT NOT NULL
);
INSERT INTO "new_PushSubs" ("id", "npub", "pushId", "pushSubscription", "relays", "timestamp") SELECT "id", "npub", "pushId", "pushSubscription", "relays", "timestamp" FROM "PushSubs";
DROP TABLE "PushSubs";
ALTER TABLE "new_PushSubs" RENAME TO "PushSubs";
CREATE UNIQUE INDEX "PushSubs_pushId_key" ON "PushSubs"("pushId");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
