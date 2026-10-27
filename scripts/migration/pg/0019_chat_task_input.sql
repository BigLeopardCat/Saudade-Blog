-- HTTP 重试和 SSE 重放按输入编号去重；实际生效后才写入聊天历史。
CREATE TABLE IF NOT EXISTS chat_task_input (
    user_id integer NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    conversation_id integer NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
    task_id varchar(100) NOT NULL,
    input_id varchar(100) NOT NULL,
    content text NOT NULL,
    source_role varchar(32) NOT NULL,
    status varchar(16) NOT NULL CHECK (status IN ('queued','applied','not_applied')),
    message_id integer REFERENCES chat_history(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, conversation_id, input_id)
);
