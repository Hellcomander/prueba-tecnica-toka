-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "department" VARCHAR(80),
    "job_title" VARCHAR(80),
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "status_reason" VARCHAR(200),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles_view" (
    "user_id" UUID NOT NULL,
    "roles" TEXT[],
    "assignments_version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_roles_view_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_email_key" ON "user_profiles"("email");

-- CreateIndex
CREATE INDEX "user_profiles_status_idx" ON "user_profiles"("status");

-- CreateIndex
CREATE INDEX "user_profiles_created_at_idx" ON "user_profiles"("created_at");

-- CreateIndex
CREATE INDEX "user_roles_view_roles_idx" ON "user_roles_view" USING GIN ("roles");
