export type Role = "owner" | "member";

export interface Room {
  id: string;                               // ABC-123-XYZ
  isPublic: boolean;                        // false = hidden
  maxUsers: number;                         // 2‒6
  members: Record<string, string>;          // userId → username
  hash: string;                             // SHA-256 password
}


export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  username: string;
  content: string;
  sentAt: string;            // ISO
}
