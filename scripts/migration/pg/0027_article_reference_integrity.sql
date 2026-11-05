-- Parent deletion is one atomic operation; comments, votes and editor revisions cannot outlive it.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='note'::regclass AND conname='note_draft_parent_fk') THEN
        ALTER TABLE note ADD CONSTRAINT note_draft_parent_fk FOREIGN KEY(draft_of) REFERENCES note(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='note_comment'::regclass AND conname='comment_article_fk') THEN
        ALTER TABLE note_comment ADD CONSTRAINT comment_article_fk FOREIGN KEY(note_id) REFERENCES note(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='note_comment_vote'::regclass AND conname='comment_vote_parent_fk') THEN
        ALTER TABLE note_comment_vote ADD CONSTRAINT comment_vote_parent_fk FOREIGN KEY(comment_id) REFERENCES note_comment(id) ON DELETE CASCADE;
    END IF;
END $$;
COMMENT ON COLUMN note_comment.note_id IS '所属文章；永久删除文章时同步删除评论';
COMMENT ON COLUMN note_comment_vote.comment_id IS '所属评论；永久删除评论时同步删除投票';
