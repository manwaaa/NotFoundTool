// Vercel Serverless Function: GET /api/config
// Returns Supabase Cloud Sync configuration from Vercel Environment Variables or defaults.

const DEFAULT_SUPABASE_URL = 'https://paizlgzyylvcwfwfwusw.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_ijU8ECGh2hKAZo1FUmPTaw_koet73o7';

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const rawUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const rawKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

  if (rawUrl && rawKey) {
    const cleanUrl = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '').trim();
    return res.status(200).json({
      enabled: true,
      config: {
        supabaseUrl: cleanUrl,
        supabaseAnonKey: rawKey.trim()
      }
    });
  }

  return res.status(200).json({
    enabled: false,
    message: 'No Supabase configuration detected.'
  });
};
