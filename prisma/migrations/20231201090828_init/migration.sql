-- CreateTable
CREATE TABLE "PushSubs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pushId" TEXT NOT NULL,
    "timestamp" INTEGER NOT NULL,
    "npub" TEXT NOT NULL,
    "pushSubscription" TEXT NOT NULL,
    "relays" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "NpubData" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "timestamp" INTEGER NOT NULL,
    "npub" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "pwh2" TEXT NOT NULL,
    "salt" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubs_pushId_key" ON "PushSubs"("pushId");
