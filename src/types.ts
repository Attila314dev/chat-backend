export type Role = "owner" | "member";

export interface Room {
  id: string;                // pl. abc-123-d4e
  isPublic: boolean;
  password?: string;         // MVP – később hash
  members: Record<string, string>; // userId → username
}

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  username: string;
  content: string;
  sentAt: string;            // ISO
}
