import {
  CopilotChat,
  CopilotKitProvider,
  HttpAgent,
  useInterrupt,
} from "@copilotkit/react-core/v2";
import { createRoot } from "react-dom/client";
import "@copilotkit/react-core/v2/styles.css";

const agent = new HttpAgent({ url: "/agui" });

function ToolApproval() {
  useInterrupt({
    enabled: ({ value }) =>
      (value as { reason?: string })?.reason === "tool_approval",
    render: ({ interrupt, resolve }) => {
      const meta = interrupt?.metadata as
        | { name?: string; arguments?: string }
        | undefined;
      return (
        <div
          style={{
            border: "1px solid #e3e2dd",
            borderRadius: 8,
            padding: 12,
            font: "13px ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <div>{interrupt?.message}</div>
          {meta?.arguments && (
            <pre
              style={{ background: "#f5f4f0", padding: 8, overflowX: "auto" }}
            >
              {meta.name} {meta.arguments}
            </pre>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => resolve({ approved: true })}>
              許可
            </button>
            <button type="button" onClick={() => resolve({ approved: false })}>
              拒否
            </button>
          </div>
        </div>
      );
    },
  });
  return null;
}

function App() {
  return (
    <CopilotKitProvider agents__unsafe_dev_only={{ default: agent }}>
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column" }}
      >
        <header
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid #e3e2dd",
            font: "13px ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <strong>hand-made-agent</strong> — CopilotKit 版プレゼンテーション層
        </header>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ToolApproval />
          <CopilotChat />
        </div>
      </div>
    </CopilotKitProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("#root が見つかりません");
createRoot(root).render(<App />);
