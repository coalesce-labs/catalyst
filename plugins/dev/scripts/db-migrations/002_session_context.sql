-- Add working directory and git branch to sessions for worktree mapping.
ALTER TABLE sessions ADD COLUMN cwd TEXT;
ALTER TABLE sessions ADD COLUMN git_branch TEXT;
