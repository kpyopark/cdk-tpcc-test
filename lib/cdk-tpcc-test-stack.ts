import * as cdk from '@aws-cdk/core';
import ec2 = require('@aws-cdk/aws-ec2');
// import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
// import as = require('@aws-cdk/aws-appstream');
import s3 = require('@aws-cdk/aws-s3');
import iam = require('@aws-cdk/aws-iam');
import s3deploy = require('@aws-cdk/aws-s3-deployment');
import rds = require('@aws-cdk/aws-rds')

const vpcenv = process.env.vpcenv === undefined ? "test" : process.env.vpcenv;
const corp =
  process.env.corpname === undefined ? "ynjcorp" : process.env.corpname;
const servicename =
  process.env.servicename === undefined ? "tpcctest" : process.env.servicename;
const elemPrefix = `${vpcenv}-${corp}-${servicename}`;
const ec2keypair =
  process.env.keypair === undefined ? "sample_keypair" : process.env.keypair;

export class CdkTpccTestStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // https://stackoverflow.com/questions/21122342/how-to-clean-node-modules-folder-of-packages-that-are-not-in-package-json
    // Sometimes, the below 'this' instance might show errors cause of recusively installed node_modules in AWS CDK.
    // At that time, you can use below command in bash shell './node_modules'
    // find . -name 'node_modules' -type d -prune -print -exec rm -rf '{}' \;
    // The code that defines your stack goes here
    
    const vpcCidr = "172.24.0.0/16";
    const publicSubnetCidr = ["172.24.10.0/24", "172.24.11.0/24"];
    const privateSubnetCidr = ["172.24.80.0/24", "172.24.81.0/24"]
    
    // 1. create vpc and subnet
    const vpcTpcc = new ec2.Vpc(this, `${elemPrefix}-vpctpcctest`, {
      cidr : vpcCidr,
      enableDnsSupport : true,
      enableDnsHostnames : true,
      maxAzs : 3,
      subnetConfiguration : []
    });

    const publicSubnetA = new ec2.PublicSubnet(
      this, 
      `${elemPrefix}-publica`,
      {
        availabilityZone : "ap-northeast-2a",
        cidrBlock : publicSubnetCidr[0],
        vpcId : vpcTpcc.vpcId,
        mapPublicIpOnLaunch : true
      }
    )

    const publicSubnetC = new ec2.PublicSubnet(
      this,
      `${elemPrefix}-publicc`,
      {
        availabilityZone : "ap-northeast-2c",
        cidrBlock: publicSubnetCidr[1],
        vpcId : vpcTpcc.vpcId,
        mapPublicIpOnLaunch : true
      }
    )

    const privateSubnetA = new ec2.PrivateSubnet(
      this,
      `${elemPrefix}-privatea`,
      {
        availabilityZone : "ap-northeast-2a",
        cidrBlock : privateSubnetCidr[0],
        vpcId : vpcTpcc.vpcId,
        mapPublicIpOnLaunch : false
      }
    )

    const privateSubnetC = new ec2.PrivateSubnet(
      this, 
      `${elemPrefix}-privatec`,
      {
        availabilityZone : "ap-northeast-2c",
        cidrBlock : privateSubnetCidr[1],
        vpcId : vpcTpcc.vpcId,
        mapPublicIpOnLaunch : false
      }
    )

    const vpcTpccIgw = new ec2.CfnInternetGateway(this, `${elemPrefix}-vpctpcc-igw`);
    const vpcTpccIgwAttachment = new ec2.CfnVPCGatewayAttachment(
      this,
      `${elemPrefix}-vpctpcc-igwattach`,
      {
        internetGatewayId : vpcTpccIgw.ref,
        vpcId : vpcTpcc.vpcId
      }
    )

    publicSubnetA.addDefaultInternetRoute(
      vpcTpccIgw.ref,
      vpcTpccIgwAttachment
    )

    publicSubnetC.addDefaultInternetRoute(
      vpcTpccIgw.ref,
      vpcTpccIgwAttachment
    )

    // 2. create aurora instance with RR
    const aurora = new rds.DatabaseCluster(
      this,
      `${elemPrefix}-vpctpcc-auroracluster`,
      {
        engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
        engineVersion : "5.7.mysql_aurora.2.07.2",
        parameterGroup : {
          parameterGroupName : "default.aurora-mysql5.7",
        },
        masterUser: {
          username: "testuser",
        },
        instanceProps: {
          instanceType: ec2.InstanceType.of(
            ec2.InstanceClass.R5,
            ec2.InstanceSize.LARGE
          ),
          vpcSubnets: {
            subnets: [privateSubnetA, privateSubnetC],
          },
          vpc: vpcTpcc,
        },
      }
    );

    // 3. create ec2 instance with tpcc application
    const amznImage = ec2.MachineImage.latestAmazonLinux({
      generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      edition: ec2.AmazonLinuxEdition.STANDARD,
      virtualization: ec2.AmazonLinuxVirt.HVM,
      storage: ec2.AmazonLinuxStorage.GENERAL_PURPOSE,
    });

    const sshsg = new ec2.SecurityGroup(this, `${elemPrefix}-vpctpcc-sshsg`, {
      vpc : vpcTpcc,
      securityGroupName : `${elemPrefix}-vpctpcc-sshsg`,
      description : "ssh only",
      allowAllOutbound : true
    });
    sshsg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "allow public ssh"
    );

    const userdata = ec2.UserData.forLinux({
      shebang: `#!/bin/bash -ex
      exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1
      echo BEGIN_USERSCRIPT
      date '+%Y-%m-%d %H:%M:%S'
      sudo yum update -y
      # install maven. https://docs.aws.amazon.com/neptune/latest/userguide/iam-auth-connect-prerq.html
      sudo wget https://repos.fedorapeople.org/repos/dchen/apache-maven/epel-apache-maven.repo -O /etc/yum.repos.d/epel-apache-maven.repo
      sudo sed -i s/\\$releasever/6/g /etc/yum.repos.d/epel-apache-maven.repo
      sudo yum install -y apache-maven
      # install git
      sudo yum install git -y
      # install tpcc application
      git clone https://github.com/kpyopark/tpcc.git
      cd tpcc
      # replace jdbc driver
      // 
      // mvn package assembly:single
      echo END_USERSCRIPT
      `,
    });

    const tpccInst = new ec2.Instance(this, `${elemPrefix}-vpctpcc-tpccinst`, {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.M5,
        ec2.InstanceSize.LARGE
      ),
      machineImage: amznImage,
      vpc: vpcTpcc,
      userData: userdata,
      allowAllOutbound: true,
      instanceName: `${elemPrefix}-vpctpcc-tpccinst`,
      keyName: ec2keypair,
      securityGroup: sshsg,
      vpcSubnets: {
        subnets: [publicSubnetA],
      },
      sourceDestCheck: false,
    });

    // 4. start tpcc application & export logs to s3
    const tpcclogbucket = new s3.Bucket(this, `${elemPrefix}-bucket`, {
      bucketName: `${elemPrefix}-logs`,
    });

    tpccInst.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:*"],
        resources: [tpcclogbucket.bucketArn + "/*"],
      })
    );

  }
}
