"use client";
import Link from "next/link";
import { ChatWindow } from "@/components/chat/chat-window";
export default function ChatPreview() {
  return (
    <>
      <div
        style={{
          maxWidth: 1164,
          margin: "0 auto 20px",
          padding: "10px 14px",
          background: "#f2f5ec",
          borderRadius: 10,
          fontSize: 12,
          color: "#637258",
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span>
          Chat design preview · Try a reply or New chat. Replies are simulated.
        </span>
        <Link
          href="/"
          style={{ textDecoration: "underline", whiteSpace: "nowrap" }}
        >
          Homepage
        </Link>
      </div>
      <ChatWindow preview />
    </>
  );
}
