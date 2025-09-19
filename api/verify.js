import crypto from "crypto";

export default function handler(req, res) {
  try {
    const cookies = req.headers.cookie || "";
    const item = cookies.split(";").map(c => c.trim()).find(c => c.startsWith("magic="));
    if (!item) return res.status(401).json({ ok: false });

    const token = item.split("=")[1];
    const [b64, sig] = token.split(".");
    const dataStr = Buffer.from(b64, "base64").toString();

    const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET || "please-set").update(dataStr).digest("hex");
    if (sig !== expected) return res.status(401).json({ ok: false });

    const payload = JSON.parse(dataStr);
    if (payload.exp < Date.now()) return res.status(401).json({ ok: false, expired: true });

    return res.status(200).json({ ok: true });
  } catch {
    return res.status(401).json({ ok: false });
  }
}
