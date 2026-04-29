"use client";

import { useState, useEffect } from "react";

interface ProviderData {
  name: string;
  status: string;
  monthlyCost: number;
  metrics: { label: string; value: string; type?: string }[];
  bar?: { pct: number };
  link?: string;
}

export default function ExpenseDashboard() {
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState("");

  async function loadAll() {
    setLoading(true);
    try {
      const res = await fetch("/api/expenses");
      const data = await res.json();
      setProviders(data.providers);
      setLastUpdated(new Date().toLocaleString());
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  const totalMonthly = providers.reduce((sum, p) => sum + (p.monthlyCost || 0), 0);

  return (
    <div className="max-w-[1200px] mx-auto p-6">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">Expense Dashboard</h1>
        <button
          onClick={loadAll}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      <p className="text-sm text-gray-400 mb-6">
        Video Research Pipeline — All Providers
        {lastUpdated && ` · Updated ${lastUpdated}`}
      </p>

      {/* Cards grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        {providers.map((p) => (
          <div key={p.name} className="bg-white rounded-xl p-5 shadow-sm border">
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full ${
                p.status === "ok" ? "bg-green-500" :
                p.status === "warn" ? "bg-yellow-500" :
                p.status === "error" ? "bg-red-500" : "bg-gray-300"
              }`} />
              <h2 className="text-sm font-semibold">{p.name}</h2>
            </div>

            <div className="space-y-1">
              {p.metrics.map((m, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-gray-500">{m.label}</span>
                  <span className={`font-mono font-semibold ${
                    m.type === "cost" ? "text-red-600" :
                    m.type === "ok" ? "text-green-600" : "text-gray-800"
                  }`}>{m.value}</span>
                </div>
              ))}
            </div>

            {p.bar && (
              <div className="mt-3 bg-gray-100 rounded-full h-1.5">
                <div
                  className={`h-1.5 rounded-full transition-all ${
                    p.bar.pct > 80 ? "bg-red-500" :
                    p.bar.pct > 50 ? "bg-yellow-500" : "bg-green-500"
                  }`}
                  style={{ width: `${Math.min(100, p.bar.pct)}%` }}
                />
              </div>
            )}

            {p.link && (
              <a href={p.link} target="_blank" rel="noopener noreferrer"
                className="text-[11px] text-blue-500 hover:underline mt-2 inline-block">
                View dashboard →
              </a>
            )}
          </div>
        ))}
      </div>

      {/* Summary */}
      <div className="bg-white rounded-xl p-5 shadow-sm border">
        <h2 className="text-sm font-semibold mb-3">Monthly Estimate: <span className="text-red-600">${totalMonthly.toFixed(2)}</span></h2>
        <div className="space-y-1">
          {providers.filter(p => p.monthlyCost > 0).sort((a, b) => b.monthlyCost - a.monthlyCost).map((p) => (
            <div key={p.name} className="flex justify-between text-xs">
              <span className="text-gray-500">{p.name}</span>
              <span className="font-mono font-semibold text-red-600">${p.monthlyCost.toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
