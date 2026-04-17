-- CreateTable
CREATE TABLE "communication_users" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "domainUserId" TEXT NOT NULL,
    "matrixUserId" TEXT,
    "displayName" TEXT NOT NULL,
    "matrixDisplayName" TEXT,
    "matrixPassword" TEXT,
    "participantType" TEXT NOT NULL DEFAULT 'DOMAIN',
    "sipUsername" TEXT,
    "sipPassword" TEXT,
    "sipDisplayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_rooms" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sittingMode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROVISIONED',
    "matrixRoomId" TEXT,
    "janusAudioRoomId" INTEGER,
    "janusVideoRoomId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_memberships" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'PARTICIPANT',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "communication_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_audit_logs" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "communication_users_matrixUserId_key" ON "communication_users"("matrixUserId");

-- CreateIndex
CREATE UNIQUE INDEX "communication_users_sipUsername_key" ON "communication_users"("sipUsername");

-- CreateIndex
CREATE INDEX "communication_users_appId_idx" ON "communication_users"("appId");

-- CreateIndex
CREATE INDEX "communication_users_participantType_idx" ON "communication_users"("participantType");

-- CreateIndex
CREATE UNIQUE INDEX "communication_users_appId_domainUserId_key" ON "communication_users"("appId", "domainUserId");

-- CreateIndex
CREATE INDEX "communication_rooms_appId_contextType_idx" ON "communication_rooms"("appId", "contextType");

-- CreateIndex
CREATE INDEX "communication_rooms_status_idx" ON "communication_rooms"("status");

-- CreateIndex
CREATE UNIQUE INDEX "communication_rooms_appId_contextType_contextId_key" ON "communication_rooms"("appId", "contextType", "contextId");

-- CreateIndex
CREATE INDEX "communication_memberships_roomId_idx" ON "communication_memberships"("roomId");

-- CreateIndex
CREATE INDEX "communication_memberships_userId_idx" ON "communication_memberships"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "communication_memberships_roomId_userId_key" ON "communication_memberships"("roomId", "userId");

-- CreateIndex
CREATE INDEX "communication_audit_logs_roomId_idx" ON "communication_audit_logs"("roomId");

-- CreateIndex
CREATE INDEX "communication_audit_logs_action_idx" ON "communication_audit_logs"("action");

-- AddForeignKey
ALTER TABLE "communication_memberships" ADD CONSTRAINT "communication_memberships_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "communication_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_memberships" ADD CONSTRAINT "communication_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "communication_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_audit_logs" ADD CONSTRAINT "communication_audit_logs_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "communication_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

