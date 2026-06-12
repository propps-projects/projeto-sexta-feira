-- Checkout (ValidaPay hosted session) settings, operator-editable in /super-admin.
-- Redirect URLs after payment + page branding. {slug} and {plan} are interpolated
-- at signup; relative URLs are resolved against PUBLIC_URL. Empty color = ValidaPay
-- default. See public-router signupPost + lib/validapay createCheckoutSession.
--
-- Idempotent.

INSERT INTO app_settings (key, value) VALUES
  ('checkout_success_url',    '/t/{slug}/admin/login'),
  ('checkout_failure_url',    '/signup?plan={plan}'),
  ('checkout_company_name',   'Askine'),
  ('checkout_primary_color',  ''),
  ('checkout_secondary_color', ''),
  ('checkout_font_color',     '')
ON CONFLICT (key) DO NOTHING;
