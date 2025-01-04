import {SendMessageCommand, SQSClient} from "@aws-sdk/client-sqs";

const sqsClient = new SQSClient();

export async function sendMessageToSQS(metadata: Record<string, any>) {
    const queueUrl = process.env.SQS_QUEUE_URL!;
    const command = new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(metadata),
    });

    try {
        const response = await sqsClient.send(command);
        console.log('Message sent to SQS:', response.MessageId);
    } catch (error) {
        console.error('Failed to send message to SQS:', error);
    }
}
