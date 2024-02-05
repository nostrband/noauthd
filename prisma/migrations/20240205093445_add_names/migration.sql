-- CreateTable
CREATE TABLE "Names" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "npub" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Names_name_key" ON "Names"("name");
