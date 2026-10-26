"use client";

import { Card, Col, Row, Typography } from "antd";
import { ApiStatus } from "@/components/api-status";

const { Title, Paragraph } = Typography;

export default function Home() {
  return (
    <main className="mx-auto min-h-screen max-w-6xl p-6 md:p-10">
      <header className="mb-8">
        <Title level={2}>
          Enterprise Agent Platform
        </Title>

        <Paragraph type="secondary">
          AI FDE Training · Day 1
        </Paragraph>
      </header>

      <Row gutter={[16, 16]}>
        <Col xs={24} md={12}>
          <Card title="Frontend">
            <Title level={4}>Next.js</Title>
            <Paragraph>
              TypeScript + Tailwind CSS + Ant Design
            </Paragraph>
          </Card>
        </Col>

        <Col xs={24} md={12}>
          <ApiStatus />
        </Col>
      </Row>
    </main>
  );
}
