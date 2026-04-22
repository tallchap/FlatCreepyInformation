"use client";

import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SNIPPY_GOOGLE_FONTS_CSS_URL } from "./snippy-fonts";

const SRC_DOC = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="${SNIPPY_GOOGLE_FONTS_CSS_URL}" />
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body {
        margin: 0;
        padding: 0;
        line-height: 1.5;
        background: #000;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        height: 100%;
        overflow: hidden;
      }
      #snippy-portal-root { width: 100%; height: 100%; }
    </style>
  </head>
  <body><div id="snippy-portal-root"></div></body>
</html>`;

interface Props {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export const SnippyPlayerIframe: React.FC<Props> = ({ children, style }) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);

  const handleLoad = () => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const root = doc.getElementById("snippy-portal-root");
    if (root) setMountNode(root);
  };

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={SRC_DOC}
        onLoad={handleLoad}
        title="Snippy preview"
        style={{
          border: 0,
          display: "block",
          width: "100%",
          aspectRatio: "16 / 9",
          borderRadius: 16,
          overflow: "hidden",
          background: "#000",
          ...style,
        }}
      />
      {mountNode && createPortal(children, mountNode)}
    </>
  );
};
