// Public connection settings. The publishable key is designed to be visible in a web app:
// real protection comes from the database's Row Level Security rules (tested in tests/db), not from hiding this key.
// NEVER put the secret / service_role key here.
window.SV_CONFIG = {
  supabaseUrl: 'https://nobfqrutkoumhuakptje.supabase.co',
  supabaseKey: 'sb_publishable_aStveG_eDTyIDVu9l0nISw_JF00WHGl'
};
