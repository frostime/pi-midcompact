import { buildAtoms } from "../src/atoms.js";
import { addDraftRange, emptyDraft } from "../src/plan.js";
import type {
  Atom,
  DraftPlan,
  MessageLike,
  SessionEntryLike,
  TransactionState,
} from "../src/types.js";
import type { ReviewWebUiView } from "../src/review-webui.js";

export const PREVIEW_FIXTURE_NAMES = [
  "review-ready",
  "review-pending",
  "selection-mixed",
  "no-telemetry",
  "wide-content",
] as const;

export type PreviewFixtureName = typeof PREVIEW_FIXTURE_NAMES[number];

export interface ReviewWebUiFixture {
  name: PreviewFixtureName;
  description: string;
  view: ReviewWebUiView;
  atoms: Atom[];
  draft: DraftPlan;
  transaction: TransactionState;
}

const DESCRIPTIONS: Record<PreviewFixtureName, string> = {
  "review-ready": "Two completed ranges separated by verbatim and protected content.",
  "review-pending": "Review draft with one summary still pending.",
  "selection-mixed": "Selection view with selected, unselected, and protected atoms.",
  "no-telemetry": "Completed review draft without Pi-reported context usage.",
  "wide-content": "CJK, emoji, image, and long-content metrics in a completed draft.",
};

export function createReviewWebUiFixture(name: PreviewFixtureName): ReviewWebUiFixture {
  const wideContent = name === "wide-content";
  const messages = fixtureMessages(wideContent);
  const branch: SessionEntryLike[] = messages.map((message, index) => ({
    id: `preview-entry-${index + 1}`,
    parentId: index === 0 ? null : `preview-entry-${index}`,
    type: "message",
    message,
  }));
  const atoms = buildAtoms(messages, branch);
  const transaction: TransactionState = {
    version: 1,
    id: `preview-${name}`,
    anchorEntryId: branch.at(-1)?.id ?? "",
    startedAt: new Date().toISOString(),
    ...(name === "no-telemetry" ? {} : {
      anchorUsage: {
        tokens: 160_000,
        contextWindow: 200_000,
        percent: 80,
        capturedAt: new Date().toISOString(),
      },
    }),
  };

  let draft = emptyDraft(transaction.id);
  draft = addDraftRange(draft, atoms, {
    start: "a0001",
    end: "a0003",
    topic: wideContent ? "认证流程" : "authentication flow",
    summary: wideContent
      ? "梳理了登录流程、令牌刷新策略和失败恢复路径。"
      : "Established the authentication flow, token refresh policy, and failure recovery path.",
  });
  draft = addDraftRange(draft, atoms, {
    start: "a0005",
    end: "a0006",
    topic: wideContent ? "界面验证" : "workbench validation",
    summary: name === "review-pending"
      ? ""
      : wideContent
        ? "验证了桌面端与移动端布局，并记录图片估算的边界。"
        : "Validated the desktop and mobile workbench behavior and recorded remaining edge cases.",
  });

  return {
    name,
    description: DESCRIPTIONS[name],
    view: name === "selection-mixed" ? "selection" : "review",
    atoms,
    draft,
    transaction,
  };
}

function fixtureMessages(wideContent: boolean): MessageLike[] {
  const firstExploration = wideContent
    ? "分析登录状态、刷新令牌和并发请求。".repeat(45)
    : "Investigated login state, refresh tokens, and concurrent requests. ".repeat(24);
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

  return [
    { role: "user", content: wideContent ? "请重构认证流程并保留现有行为。" : "Refactor the authentication flow without changing behavior.", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: firstExploration }], timestamp: 2 },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Inspecting the current token lifecycle." },
        { type: "toolCall", id: "preview-read-1", name: "read", arguments: { path: "src/auth.ts" } },
      ],
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: "preview-read-1",
      toolName: "read",
      content: [{ type: "text", text: "export function refreshToken() { /* existing implementation */ }" }],
      timestamp: 4,
    },
    { role: "assistant", content: [{ type: "text", text: "The implementation can preserve the public contract while consolidating refresh state." }], timestamp: 5 },
    { role: "user", content: wideContent ? "还需要检查移动端，并确认图片不会扭曲布局。" : "Also check mobile behavior and make sure images do not distort the layout.", timestamp: 6 },
    {
      role: "assistant",
      content: [
        { type: "text", text: wideContent ? "移动端检查包含中文、emoji 🔍 和一张示例图片。" : "The mobile check includes a representative image and a long explanatory result." },
        { type: "image", mimeType: "image/png", data: imageData },
      ],
      timestamp: 7,
    },
    {
      role: "custom",
      customType: "midcompact-summary",
      summary: "An earlier committed compression block remains protected.",
      details: { blockId: "c0001" },
      timestamp: 8,
    },
    { role: "user", content: "List the final risks that should remain visible after compression.", timestamp: 9 },
    { role: "assistant", content: [{ type: "text", text: "Keep the rollback path, provider-dependent token estimate, and accessibility checks visible." }], timestamp: 10 },
  ];
}
