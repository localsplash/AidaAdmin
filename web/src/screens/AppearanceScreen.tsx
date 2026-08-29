import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi, ApiError } from '../api/admin';

export function AppearanceScreen() {
  const { tenantId = '' } = useParams();
  const [brandName, setBrandName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#1f5eda');
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    adminApi
      .getAppearance(tenantId)
      .then((res) => {
        if (res.appearance) {
          setBrandName(res.appearance.brand_name);
          setPrimaryColor(res.appearance.primary_color ?? '#1f5eda');
          setLogoPath(res.appearance.logo_asset_path);
        }
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi.saveAppearance(tenantId, brandName, primaryColor);
      setStatus('Appearance saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save appearance');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const res = await adminApi.uploadLogo(tenantId, file);
      setLogoPath(res.logoAssetPath);
      setStatus('Logo uploaded');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Logo upload failed');
    }
  };

  return (
    <section aria-labelledby="appearance-heading">
      <p>
        <Link to="/tenants">← All tenants</Link>
      </p>
      <h1 id="appearance-heading">Appearance</h1>
      {error ? <p role="alert">{error}</p> : null}
      {status ? <p role="status">{status}</p> : null}

      <form aria-labelledby="appearance-heading" onSubmit={(e) => void save(e)}>
        <label>
          Brand name
          <input required value={brandName} onChange={(e) => setBrandName(e.target.value)} />
        </label>
        <label>
          Primary color
          <input
            type="color"
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save appearance'}
        </button>
      </form>

      <h2 id="logo-heading">Logo</h2>
      {logoPath ? <img src={logoPath} alt={`${brandName || 'Brand'} logo`} width={120} /> : null}
      <label>
        Upload logo (PNG or JPEG, up to 512 KB)
        <input
          type="file"
          accept="image/png,image/jpeg"
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </label>

      <h2>Future features</h2>
      <p>
        <strong>CRM import</strong> — coming soon (not part of the POC).
      </p>
      <p>
        <strong>Conversation history</strong> — coming soon (not part of the POC).
      </p>
    </section>
  );
}
