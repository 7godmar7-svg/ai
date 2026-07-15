// ================================================================
// api/kantei.js
// Vercel Serverless Function：星月夜の無料鑑定 API中継
//
// 【配置場所】リポジトリ直下の api/kantei.js
//   ├─ index.html
//   └─ api/
//        └─ kantei.js   ← このファイル
//
// 【APIキーの設定】
//   Vercelダッシュボード → 対象プロジェクト → Settings
//   → Environment Variables → 「GEMINI_API_KEY」を追加 → Redeploy
//   ※ キーをこのファイルに直書きしないこと
// ================================================================

// 上から順に試します（モデル名変更で404になっても自動で次を使用）
const GEMINI_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash"];
const CLAUDE_MODEL = "claude-sonnet-4-5";
const MAX_BODY_BYTES = 20000;

export default async function handler(req, res) {
  // CORS（同一ドメイン運用なら実質不要だが念のため）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POSTのみ対応しています" });

  // ボディサイズ制限（悪用防止）
  const rawLen = JSON.stringify(req.body || {}).length;
  if (rawLen > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "リクエストが大きすぎます" });
  }

  const body = req.body || {};
  const system = String(body.system || "").slice(0, 8000);
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 2) : [];
  const userText = messages.length ? String(messages[0].content || "").slice(0, 4000) : "";

  try {
    // ---- ① Gemini（無料枠）優先 ----
    if (process.env.GEMINI_API_KEY) {
      let lastErr = null;
      for (const model of GEMINI_MODELS) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: userText }] }],
              generationConfig: {
                maxOutputTokens: 4000,                // thinking消費分を考慮して余裕を持たせる
                temperature: 0.8,
                responseMimeType: "application/json", // JSON形式での出力を強制
              },
            }),
          }
        );
        const data = await r.json();
        if (r.ok) {
          // HTML側が期待する形式（Anthropic互換）に変換して返す
          const text = (data.candidates?.[0]?.content?.parts || [])
            .filter(p => !p.thought)
            .map(p => p.text || "")
            .join("\n");
          if (!text.trim()) { lastErr = { status: 502, data: { error: "empty response" } }; continue; }
          return res.status(200).json({ content: [{ type: "text", text }] });
        }
        // このモデルが使えない場合は次のモデルを試す
        console.log(`[NG] モデル ${model} → HTTP ${r.status}`, JSON.stringify(data).slice(0, 300));
        lastErr = { status: r.status, data };
      }
      return res.status(lastErr.status).json({ error: "Gemini APIエラー（全モデル失敗）", detail: lastErr.data });
    }

    // ---- ② Claude（有料・GEMINI_API_KEY未設定時のみ） ----
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1000,
          system,
          messages: [{ role: "user", content: userText }],
        }),
      });
      const data = await r.json();
      return res.status(r.status).json(data);
    }

    return res.status(500).json({
      error: "APIキーが未設定です。VercelのEnvironment Variablesに GEMINI_API_KEY を設定し、Redeployしてください。",
    });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
}
