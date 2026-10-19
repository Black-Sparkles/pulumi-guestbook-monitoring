import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as fs from "fs";
import * as path from "path";

import { monitoringNamespace } from "./monitoring";

// Read the dashboard JSON from your project folder
const dashboardPath = path.join(__dirname, "guestbook-dashboard.json");

const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8"));

// Handle either a direct dashboard export
// or a dashboard wrapped in a "dashboard" property.
const dashboardModel = dashboard.dashboard ?? dashboard;

// Ensure Grafana recognizes it as a provisioned dashboard.
dashboardModel.id = null;
dashboardModel.uid = "guestbook-pulumi-monitoring";
dashboardModel.title = "Guestbook Application Monitoring";
delete dashboardModel.version;

// Use the ConfigMap discovery mechanism provided
// by the Grafana Helm chart.
const dashboardConfigMap = new k8s.core.v1.ConfigMap(
  "guestbook-grafana-dashboard",
  {
    metadata: {
      name: "guestbook-grafana-dashboard",
      namespace: monitoringNamespace.metadata.name,
      labels: {
        grafana_dashboard: "1",
      },
    },
    data: {
      "guestbook-dashboard.json": JSON.stringify(dashboardModel),
    },
  },
  {
    dependsOn: [monitoringNamespace],
  },
);

export const dashboardName = "Guestbook Application Monitoring";

export const dashboardUid = "guestbook-pulumi-monitoring";

export const dashboardUrl =
  "http://localhost:3000/d/guestbook-pulumi-monitoring";
