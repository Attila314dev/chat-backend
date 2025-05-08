export type Role = "owner" | "member";

export interface Room {
  id          : string;
  isPublic    : boolean;
  maxUsers    : number;
  hash        : string;                   // jelszó hash
  members     : Record<string, string>;   // userId → username
  loginHashes : string[];                 // hash(username), maxUsers számú engedett belépés
}


export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  username: string;
  content: string;
  sentAt: string;            // ISO
}
