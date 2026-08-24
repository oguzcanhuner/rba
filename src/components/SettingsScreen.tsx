import { useEffect, useState } from 'react';
import type { Settings } from '../claude';
import { AVAILABLE_MODELS } from '../lib/models';
import { Button } from './ui/button';

type SettingsScreenProps = {
  onBack: () => void;
};

export function SettingsScreen({ onBack }: SettingsScreenProps) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    window.settings
      .get()
      .then((loaded) => {
        if (!disposed) {
          setSettings(loaded);
        }
      })
      .catch(() => {
        if (!disposed) {
          setError('Settings could not be loaded.');
        }
      });

    return () => {
      disposed = true;
    };
  }, []);

  function updateModel(key: keyof Settings, value: string) {
    if (!settings) {
      return;
    }

    const previous = settings;
    setSettings({ ...settings, [key]: value });
    setError(null);
    window.settings.set({ [key]: value }).catch(() => {
      setSettings(previous);
      setError('This setting could not be saved.');
    });
  }

  return (
    <section className="settings-screen">
      <header className="settings-screen__header">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          ← Back
        </Button>
        <h1>Settings</h1>
      </header>
      <main className="settings-screen__content">
        {error && <div className="error-message">{error}</div>}
        {settings && (
          <div className="settings-form">
            <label className="settings-field" htmlFor="planner-model">
              <span>Planner model</span>
              <select
                id="planner-model"
                value={settings.plannerModel}
                onChange={(event) =>
                  updateModel('plannerModel', event.target.value)
                }
              >
                {AVAILABLE_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="settings-field" htmlFor="worker-model">
              <span>Worker default model</span>
              <select
                id="worker-model"
                value={settings.workerModel}
                onChange={(event) =>
                  updateModel('workerModel', event.target.value)
                }
              >
                {AVAILABLE_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </main>
    </section>
  );
}
