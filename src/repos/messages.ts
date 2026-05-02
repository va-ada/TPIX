import { db } from "../db.ts";

export type MessageRole = "user" | "boss" | "system";

export interface Message {
  id: number;
  project_id: string;
  role: MessageRole;
  author: string;
  content: string;
  created_at: string;
}

const insertStmt = db.prepare(`
  INSERT INTO messages (project_id, role, author, content)
  VALUES (@project_id, @role, @author, @content)
`);

const listStmt = db.prepare<[string], Message>(`
  SELECT * FROM messages WHERE project_id = ? ORDER BY id ASC
`);

export function appendMessage(args: {
  project_id: string;
  role: MessageRole;
  author: string;
  content: string;
}): void {
  insertStmt.run(args);
}

export function listMessages(projectId: string): Message[] {
  return listStmt.all(projectId);
}
