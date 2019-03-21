import appscaling = require('@aws-cdk/aws-applicationautoscaling');
import cloudwatch = require('@aws-cdk/aws-cloudwatch');
import ec2 = require('@aws-cdk/aws-ec2');
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import iam = require('@aws-cdk/aws-iam');
import cloudmap = require('@aws-cdk/aws-servicediscovery');
import cdk = require('@aws-cdk/cdk');
import { NetworkMode, TaskDefinition } from '../base/task-definition';
import { ICluster } from '../cluster';
import { CfnService } from '../ecs.generated';
import { ScalableTaskCount } from './scalable-task-count';

/**
 * Basic service properties
 */
export interface BaseServiceProps {
  /**
   * Cluster where service will be deployed
   */
  cluster: ICluster;

  /**
   * Number of desired copies of running tasks
   *
   * @default 1
   */
  desiredCount?: number;

  /**
   * A name for the service.
   *
   * @default CloudFormation-generated name
   */
  serviceName?: string;

  /**
   * The maximum number of tasks, specified as a percentage of the Amazon ECS
   * service's DesiredCount value, that can run in a service during a
   * deployment.
   *
   * @default 200
   */
  maximumPercent?: number;

  /**
   * The minimum number of tasks, specified as a percentage of
   * the Amazon ECS service's DesiredCount value, that must
   * continue to run and remain healthy during a deployment.
   *
   * @default 50
   */
  minimumHealthyPercent?: number;

  /**
   * Time after startup to ignore unhealthy load balancer checks.
   *
   * @default ??? FIXME
   */
  healthCheckGracePeriodSeconds?: number;
}

/**
 * Base class for Ecs and Fargate services
 */
export abstract class BaseService extends cdk.Construct
  implements elbv2.IApplicationLoadBalancerTarget, elbv2.INetworkLoadBalancerTarget {

  /**
   * Manage allowed network traffic for this service
   */
  public readonly connections: ec2.Connections = new ec2.Connections();

  /**
   * ARN of this service
   */
  public readonly serviceArn: string;

  /**
   * Name of this service
   */
  public readonly serviceName: string;

  /**
   * Name of this service's cluster
   */
  public readonly clusterName: string;

  /**
   * Task definition this service is associated with
   */
  public readonly taskDefinition: TaskDefinition;

  protected cloudmapService: cloudmap.Service;
  protected cluster: ICluster;
  protected loadBalancers = new Array<CfnService.LoadBalancerProperty>();
  protected networkConfiguration?: CfnService.NetworkConfigurationProperty;
  protected serviceRegistries = new Array<CfnService.ServiceRegistryProperty>();

  private readonly resource: CfnService;
  private scalableTaskCount?: ScalableTaskCount;

  constructor(scope: cdk.Construct,
              id: string,
              props: BaseServiceProps,
              additionalProps: any,
              clusterName: string,
              taskDefinition: TaskDefinition) {
    super(scope, id);

    this.taskDefinition = taskDefinition;

    this.resource = new CfnService(this, "Service", {
      desiredCount: props.desiredCount,
      serviceName: props.serviceName,
      loadBalancers: new cdk.Token(() => this.loadBalancers),
      deploymentConfiguration: {
        maximumPercent: props.maximumPercent || 200,
        minimumHealthyPercent: props.minimumHealthyPercent === undefined ? 50 : props.minimumHealthyPercent
      },
      healthCheckGracePeriodSeconds: props.healthCheckGracePeriodSeconds,
      /* role: never specified, supplanted by Service Linked Role */
      networkConfiguration: new cdk.Token(() => this.networkConfiguration),
      serviceRegistries: new cdk.Token(() => this.serviceRegistries),
      ...additionalProps
    });
    this.serviceArn = this.resource.serviceArn;
    this.serviceName = this.resource.serviceName;
    this.clusterName = clusterName;
    this.cluster = props.cluster;
  }

  /**
   * Called when the service is attached to an ALB
   *
   * Don't call this function directly. Instead, call listener.addTarget()
   * to add this service to a load balancer.
   */
  public attachToApplicationTargetGroup(targetGroup: elbv2.ApplicationTargetGroup): elbv2.LoadBalancerTargetProps {
    const ret = this.attachToELBv2(targetGroup);

    // Open up security groups. For dynamic port mapping, we won't know the port range
    // in advance so we need to open up all ports.
    const port = this.taskDefinition.defaultContainer!.ingressPort;
    const portRange = port === 0 ? EPHEMERAL_PORT_RANGE : new ec2.TcpPort(port);
    targetGroup.registerConnectable(this, portRange);

    return ret;
  }

  /**
   * Called when the service is attached to an NLB
   *
   * Don't call this function directly. Instead, call listener.addTarget()
   * to add this service to a load balancer.
   */
  public attachToNetworkTargetGroup(targetGroup: elbv2.NetworkTargetGroup): elbv2.LoadBalancerTargetProps {
    return this.attachToELBv2(targetGroup);
  }

  /**
   * Enable autoscaling for the number of tasks in this service
   */
  public autoScaleTaskCount(props: appscaling.EnableScalingProps) {
    if (this.scalableTaskCount) {
      throw new Error('AutoScaling of task count already enabled for this service');
    }

    return this.scalableTaskCount = new ScalableTaskCount(this, 'TaskCount', {
      serviceNamespace: appscaling.ServiceNamespace.Ecs,
      resourceId: `service/${this.clusterName}/${this.resource.serviceName}`,
      dimension: 'ecs:service:DesiredCount',
      role: this.makeAutoScalingRole(),
      ...props
    });
  }

  /**
   * Associate Service Discovery (Cloud Map) service
   */
  public addServiceRegistry(registry: ServiceRegistry) {
    const sr = this.renderServiceRegistry(registry);
    this.serviceRegistries.push(sr);
  }

  /**
   * Return the given named metric for this Service
   */
  public metric(metricName: string, props?: cloudwatch.MetricCustomization): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName,
      dimensions: { ServiceName: this.serviceName },
      ...props
    });
  }

  /**
   * Set up AWSVPC networking for this construct
   */
  // tslint:disable-next-line:max-line-length
  protected configureAwsVpcNetworking(vpc: ec2.IVpcNetwork, assignPublicIp?: boolean, vpcPlacement?: ec2.VpcPlacementStrategy, securityGroup?: ec2.ISecurityGroup) {
    if (vpcPlacement === undefined) {
      vpcPlacement = { subnetsToUse: assignPublicIp ? ec2.SubnetType.Public : ec2.SubnetType.Private };
    }
    if (securityGroup === undefined) {
      securityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', { vpc });
    }
    const subnets = vpc.subnets(vpcPlacement);
    this.connections.addSecurityGroup(securityGroup);

    this.networkConfiguration = {
      awsvpcConfiguration: {
        assignPublicIp: assignPublicIp ? 'ENABLED' : 'DISABLED',
        subnets: subnets.map(x => x.subnetId),
        securityGroups: new cdk.Token(() => [securityGroup!.securityGroupId]).toList(),
      }
    };
  }

  private renderServiceRegistry(registry: ServiceRegistry): CfnService.ServiceRegistryProperty {
    return {
      registryArn: registry.arn,
      containerName: registry.containerName,
      containerPort: registry.containerPort,
    };
  }

  /**
   * Shared logic for attaching to an ELBv2
   */
  private attachToELBv2(targetGroup: elbv2.ITargetGroup): elbv2.LoadBalancerTargetProps {
    if (this.taskDefinition.networkMode === NetworkMode.None) {
      throw new Error("Cannot use a load balancer if NetworkMode is None. Use Bridge, Host or AwsVpc instead.");
    }

    this.loadBalancers.push({
      targetGroupArn: targetGroup.targetGroupArn,
      containerName: this.taskDefinition.defaultContainer!.node.id,
      containerPort: this.taskDefinition.defaultContainer!.containerPort,
    });

    // Service creation can only happen after the load balancer has
    // been associated with our target group(s), so add ordering dependency.
    this.resource.node.addDependency(targetGroup.loadBalancerAttached);

    const targetType = this.taskDefinition.networkMode === NetworkMode.AwsVpc ? elbv2.TargetType.Ip : elbv2.TargetType.Instance;
    return { targetType };
  }

  /**
   * Generate the role that will be used for autoscaling this service
   */
  private makeAutoScalingRole(): iam.IRole {
    // Use a Service Linked Role.
    return iam.Role.import(this, 'ScalingRole', {
      roleArn: this.node.stack.formatArn({
        service: 'iam',
        resource: 'role/aws-service-role/ecs.application-autoscaling.amazonaws.com',
        resourceName: 'AWSServiceRoleForApplicationAutoScaling_ECSService',
      })
    });
  }
}

/**
 * The port range to open up for dynamic port mapping
 */
const EPHEMERAL_PORT_RANGE = new ec2.TcpPortRange(32768, 65535);

/**
 * Options for enabling service discovery on an ECS service
 */
export interface ServiceDiscoveryOptions {
  /**
   * Name of the cloudmap service to attach to the ECS Service
   *
   * @default CloudFormation-generated name
   */
  name?: string,

  /**
   * The DNS type of the record that you want AWS Cloud Map to create. Supported record types include A or SRV.
   *
   * @default: A
   */
  dnsRecordType?: cloudmap.DnsRecordType.A | cloudmap.DnsRecordType.SRV,

  /**
   * The amount of time, in seconds, that you want DNS resolvers to cache the settings for this record.
   *
   * @default 60
   */
  dnsTtlSec?: number;

  /**
   * The number of 30-second intervals that you want Cloud Map to wait after receiving an
   * UpdateInstanceCustomHealthStatus request before it changes the health status of a service instance.
   * NOTE: This is used for HealthCheckCustomConfig
   */
  failureThreshold?: number,
}

/**
 * Service Registry for ECS service
 */
export interface ServiceRegistry {
  /**
   * Arn of the Cloud Map Service that will register a Cloud Map Instance for your ECS Service
   */
  arn: string;

  /**
   * The container name value, already specified in the task definition, to be used for your service discovery service.
   * If the task definition that your service task specifies uses the bridge or host network mode,
   * you must specify a containerName and containerPort combination from the task definition.
   * If the task definition that your service task specifies uses the awsvpc network mode and a type SRV DNS record is
   * used, you must specify either a containerName and containerPort combination or a port value, but not both.
   */
  containerName?: string;

  /**
   * The container port value, already specified in the task definition, to be used for your service discovery service.
   * If the task definition that your service task specifies uses the bridge or host network mode,
   * you must specify a containerName and containerPort combination from the task definition.
   * If the task definition that your service task specifies uses the awsvpc network mode and a type SRV DNS record is
   * used, you must specify either a containerName and containerPort combination or a port value, but not both.
   */
  containerPort?: number;
}
