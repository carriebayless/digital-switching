import crypto from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { magicNumber } = req.body || {};
  if (!magicNumber) return res.status(400).json({ error: "Missing magicNumber" });

  if (String(magicNumber) !== String(process.env.MAGIC_NUMBER)) {
    return res.status(401).json({ error: "Invalid security number" });
  }

  const expiresMs = 8 * 60 * 60 * 1000; // 8 hours
  const payload = { exp: Date.now() + expiresMs };
  const dataStr = JSON.stringify(payload);
  const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET || "please-set").update(dataStr).digest("hex");
  const token = Buffer.from(dataStr).toString("base64") + "." + signature;

  res.setHeader("Set-Cookie", `magic=${token}; HttpOnly; Path=/; Max-Age=${expiresMs/1000}; Secure; SameSite=Lax`);
  res.status(200).json({ ok: true });
}
