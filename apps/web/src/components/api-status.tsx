"use client";

import { Alert, Button, Card, Space, Tag, Typography } from "antd";
import { useEffect, useState } from "react";

type HealthStatus = {
  status: "ok" | "error";
  service: string;
};

async function fetchHealth(): Promise<HealthStatus> {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("API unavailable");
    }
    return await response.json();
  } catch {
    return { status: "error", service: "business-api" };
  }
}

export function ApiStatus() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(true);

  async function checkHealth() {
    const data = await fetchHealth();
    setHealth(data);
    setLoading(false);
  }

  useEffect(() => {
    let active = true;
    void fetchHealth().then((data) => {
      if (active) {
        setHealth(data);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const healthy = health?.status === "ok";

  return (
    <Card title="Backend API" className="w-full">
      <Space orientation="vertical" size="middle">
        <Space>
          <Typography.Text>Service:</Typography.Text>
          <Typography.Text strong>
            business-api
          </Typography.Text>
        </Space>

        <Tag color={healthy ? "success" : "error"}>
          {loading
            ? "Checking"
            : healthy
              ? "Healthy"
              : "Unavailable"}
        </Tag>

        {!loading && !healthy && (
          <Alert
            type="warning"
            title="Go API is unavailable"
            showIcon
          />
        )}

        <Button
          loading={loading}
          onClick={() => {
            setLoading(true);
            void checkHealth();
          }}
        >
          Check API
        </Button>
      </Space>
    </Card>
  );
}
