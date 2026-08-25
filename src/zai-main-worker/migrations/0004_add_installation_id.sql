-- Migration: Add installation_id to jobs table for GitHub App authentication
-- Up: Add installation_id column to jobs table

ALTER TABLE jobs ADD COLUMN installation_id INTEGER;

-- Create index for installation_id to speed up queries
CREATE INDEX IF NOT EXISTS idx_jobs_installation_id ON jobs(installation_id);

-- Add installation_id to webhook_deliveries table for tracking
ALTER TABLE webhook_deliveries ADD COLUMN installation_id INTEGER;

-- Add installation_id to repositories table for reference
ALTER TABLE repositories ADD COLUMN github_app_installation_id INTEGER;
