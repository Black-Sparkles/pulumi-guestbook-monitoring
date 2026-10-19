// import * as k8s from "@pulumi/kubernetes";

// // Create a separate namespace for monitoring tools
// export const monitoringNamespace = new k8s.core.v1.Namespace(
//   "monitoring-namespace",
//   {
//     metadata: {
//       name: "monitoring",
//     },
//   },
// );

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

// Read the Grafana password securely
const grafanaPassword = config.requireSecret("grafanaAdminPassword");

// Create the monitoring namespace
export const monitoringNamespace = new k8s.core.v1.Namespace(
  "monitoring-namespace",
  {
    metadata: {
      name: "monitoring",
    },
  },
);

// Install Prometheus and Grafana using Helm
const monitoringStack = new k8s.helm.v3.Release(
  "monitoring-stack",
  {
    name: "monitoring",
    chart: "kube-prometheus-stack",
    repositoryOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    namespace: monitoringNamespace.metadata.name,

    values: {
      // Disable unnecessary components for local testing
      alertmanager: {
        enabled: false,
      },

      // Grafana configuration
      grafana: {
        enabled: true,
        adminUser: "admin",
        adminPassword: grafanaPassword,

        sidecar: {
          dashboards: {
            enabled: true,
            label: "grafana_dashboard",
            labelValue: "1",
            searchNamespace: "ALL",
          },
        },

        service: {
          type: "NodePort",
          nodePort: 30030,
        },

        resources: {
          requests: {
            memory: "128Mi",
            cpu: "50m",
          },
          limits: {
            memory: "384Mi",
            cpu: "500m",
          },
        },
      },

      // Prometheus configuration
      prometheus: {
        enabled: true,

        prometheusSpec: {
          retention: "24h",

          resources: {
            requests: {
              memory: "256Mi",
              cpu: "100m",
            },
            limits: {
              memory: "1Gi",
              cpu: "1000m",
            },
          },

          // Allow additional Guestbook monitors
          serviceMonitorSelectorNilUsesHelmValues: false,
          serviceMonitorSelector: {},
          serviceMonitorNamespaceSelector: {},

          probeSelectorNilUsesHelmValues: false,
          probeSelector: {},
          probeNamespaceSelector: {},
        },
      },
    },
  },
  {
    dependsOn: [monitoringNamespace],
  },
);

// Pulumi outputs
export const grafanaUrl = "http://localhost:3000";
export const grafanaNodePort = 30030;
export const grafanaUsername = "admin";
export const grafanaAdminPassword = grafanaPassword;
export const prometheusUrl = "http://localhost:9090";

function createRedisExporter(name: string, redisHost: string) {
  const labels = { app: name };

  // Deploy Redis Exporter
  const deployment = new k8s.apps.v1.Deployment(name, {
    metadata: {
      name: name,
    },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: labels,
      },
      template: {
        metadata: {
          labels: labels,
        },
        spec: {
          containers: [
            {
              name: "redis-exporter",
              image: "oliver006/redis_exporter:v1.80.1",
              env: [
                {
                  name: "REDIS_ADDR",
                  value: `redis://${redisHost}:6379`,
                },
              ],
              ports: [
                {
                  name: "metrics",
                  containerPort: 9121,
                },
              ],
            },
          ],
        },
      },
    },
  });

  // Create a service for Prometheus to access
  const service = new k8s.core.v1.Service(
    `${name}-service`,
    {
      metadata: {
        name: name,
        labels: labels,
      },
      spec: {
        selector: labels,
        ports: [
          {
            name: "metrics",
            port: 9121,
            targetPort: "metrics",
          },
        ],
      },
    },
    { dependsOn: [deployment] },
  );

  // Tell Prometheus to scrape exporter metrics
  new k8s.apiextensions.CustomResource(
    `${name}-monitor`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: {
        name: `${name}-monitor`,
      },
      spec: {
        selector: {
          matchLabels: labels,
        },
        endpoints: [
          {
            port: "metrics",
            path: "/metrics",
            interval: "15s",
          },
        ],
      },
    },
    { dependsOn: [monitoringStack, service] },
  );
}

// Monitor both Guestbook Redis services
createRedisExporter("redis-leader-exporter", "redis-leader");

createRedisExporter("redis-replica-exporter", "redis-replica");

const blackboxLabels = {
  app: "guestbook-blackbox",
};

// Deploy the Blackbox Exporter
const blackboxDeployment = new k8s.apps.v1.Deployment("guestbook-blackbox", {
  metadata: {
    name: "guestbook-blackbox",
  },
  spec: {
    replicas: 1,
    selector: {
      matchLabels: blackboxLabels,
    },
    template: {
      metadata: {
        labels: blackboxLabels,
      },
      spec: {
        containers: [
          {
            name: "blackbox-exporter",
            image: "prom/blackbox-exporter:v0.27.0",
            ports: [
              {
                name: "http",
                containerPort: 9115,
              },
            ],
            resources: {
              requests: {
                cpu: "20m",
                memory: "32Mi",
              },
            },
          },
        ],
      },
    },
  },
});

// Create a Kubernetes Service
const blackboxService = new k8s.core.v1.Service(
  "guestbook-blackbox-service",
  {
    metadata: {
      name: "guestbook-blackbox",
      labels: blackboxLabels,
    },
    spec: {
      selector: blackboxLabels,
      ports: [
        {
          name: "http",
          port: 9115,
          targetPort: "http",
        },
      ],
    },
  },
  {
    dependsOn: [blackboxDeployment],
  },
);

// Create a Prometheus Probe for Guestbook
const frontendProbe = new k8s.apiextensions.CustomResource(
  "guestbook-frontend-probe",
  {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "Probe",
    metadata: {
      name: "guestbook-frontend-probe",
    },
    spec: {
      jobName: "guestbook-frontend",
      interval: "15s",
      module: "http_2xx",

      prober: {
        url: "guestbook-blackbox.default.svc.cluster.local:9115",
      },

      targets: {
        staticConfig: {
          static: ["http://frontend.default.svc.cluster.local:80"],
        },
      },
    },
  },
  {
    dependsOn: [monitoringStack, blackboxService],
  },
);
