import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const s3Client = new S3Client();

export async function uploadToS3(
    bucketName: string,
    key: string,
    body: string
) {
    try {
        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: body,
            ContentType: "application/json",
        });

        await s3Client.send(command);
        console.log(`Successfully uploaded to S3: Bucket=${bucketName}, Key=${key}`);
    } catch (error) {
        console.error(
            `Failed to upload to S3: Bucket=${bucketName}, Key=${key}, Error=${error}`
        );
        throw error;
    }
}
