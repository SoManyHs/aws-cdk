import ec2 = require('@aws-cdk/aws-ec2');
import autoscaling = require('@aws-cdk/aws-autoscaling');
import ecs = require('@aws-cdk/aws-ecs');
import cdk = require('@aws-cdk/cdk');

class BonjourECS extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.VpcNetwork(this, 'MyVpc', { maxAZs: 2 });
    const cluster = new ecs.Cluster(this, 'Ec2Cluster', { vpc });

    const asg = new autoscaling.AutoScalingGroup(this, 'MyFleet', {
      instanceType: new ec2.InstanceTypePair(ec2.InstanceClass.M4, ec2.InstanceSize.Micro),
      machineImage: new ec2.AmazonLinuxImage(),
      vpc
    });

    const userData = `
Content-Type: multipart/mixed; boundary="//"
MIME-Version: 1.0

--//
Content-Type: text/cloud-config; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="cloud-config.txt"

#cloud-config
cloud_final_modules:
- [scripts-user, always]

--//
Content-Type: text/x-shellscript; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="userdata.txt"

#!/bin/bash
/bin/echo "Hello World" >> /tmp/testfile.txt
--//
`
    asg.addUserData(userData);

    cluster.addAutoScalingGroupCapacity(asg);
  }
}

const app = new cdk.App();

new BonjourECS(app, 'Bonjour');

app.run();
