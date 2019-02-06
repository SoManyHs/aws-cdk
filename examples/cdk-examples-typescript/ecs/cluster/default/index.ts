import ec2 = require('@aws-cdk/aws-ec2');
import { InstanceType } from '@aws-cdk/aws-ec2';
import ecs = require('@aws-cdk/aws-ecs');
import cdk = require('@aws-cdk/cdk');

class BonjourECS extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.VpcNetwork(this, 'MyVpc', { maxAZs: 2 });
    const cluster = new ecs.Cluster(this, 'Ec2Cluster', { vpc });
    cluster.addDefaultAutoScalingGroupCapacity({
      instanceType: new InstanceType("t2.xlarge"),
      instanceCount: 3,
    });
  }
}

const app = new cdk.App();

new BonjourECS(app, 'Bonjour');

app.run();
