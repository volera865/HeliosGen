"use client";

import type { ModelGuidanceResult } from "@/lib/modelGuidance";

type Props = {
  guidance: ModelGuidanceResult;
  onTryModel?: (modelId: string) => void;
};

export function ModelGuidanceStrip({ guidance, onTryModel }: Props) {
  if (!guidance.summary) return null;

  const fitColor =
    guidance.fit === "good"
      ? "rgba(45,212,191,0.75)"
      : guidance.fit === "ok"
        ? "rgba(251,191,36,0.75)"
        : "rgba(251,146,60,0.85)";

  return (
    <div
      style={{
        flex: "1 1 100%",
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        paddingTop: "4px",
        fontSize: "11.5px",
        lineHeight: 1.45,
        color: "rgba(255,255,255,0.55)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "6px 10px", minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: fitColor,
            flexShrink: 0,
            marginTop: "5px",
          }}
        />
        <div style={{ flex: "1 1 200px", minWidth: 0 }}>
          {guidance.scenarioLabel && (
            <div style={{ fontSize: "10.5px", color: "rgba(255,255,255,0.38)", marginBottom: "2px" }}>
              Your setup: {guidance.scenarioLabel}
            </div>
          )}
          <span>{guidance.summary}</span>
        </div>
      </div>

      {guidance.tips?.map((tip) => (
        <div
          key={tip}
          style={{
            paddingLeft: "16px",
            fontSize: "10.5px",
            color: "rgba(255,255,255,0.42)",
            minWidth: 0,
          }}
        >
          • {tip}
        </div>
      ))}

      {guidance.suggestion && onTryModel && (
        <div
          style={{
            paddingLeft: "16px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "6px",
            minWidth: 0,
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.42)" }}>{guidance.suggestion.reason}</span>
          <button
            type="button"
            onClick={() => onTryModel(guidance.suggestion!.modelId)}
            style={{
              border: "none",
              background: "none",
              padding: 0,
              font: "inherit",
              fontSize: "11.5px",
              fontWeight: 600,
              color: "#2DD4BF",
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: "2px",
              flexShrink: 0,
            }}
          >
            Try {guidance.suggestion.label}
          </button>
        </div>
      )}
    </div>
  );
}
