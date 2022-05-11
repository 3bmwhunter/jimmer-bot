import { appendFileSync, createWriteStream, readFileSync } from "fs";
import { get } from "https";
import { resolve } from "path";

import Twit, {Twitter} from "twit";
import Puppeteer from "puppeteer";
import sizeOf from "image-size"

interface Secrets {
    bearerToken: string;
    apiKey: string;
    apiKeySecret: string;
    accessToken: string;
    accessTokenSecret: string;
    oauthClientSecret: string
    oauthClientId: string;
}

class JimmerSexBot {
    /**
     * api keys for twitter bot
     */
    private secrets!: Secrets 

    /**
     * jimmy's twitter @ 
     */
    private readonly jimmysTiwtterHandle = 'JimmyBroadbent'
    
    /**
     * maximum dimension of images that the bot will post,
     * because twitter has a size limit for photos (5MB).
     */
    private readonly maxImageDimension = 800; //[px]

    /**
     * same as src attribute of img in html file
     */
    private readonly originalImagePath = 'from-twitter';

    /**
     * id_str of jimmy's twitter account
     */
    private jimmysUserId = "";

    /**
     * twitter api client instance
     */
    private twitterClient!: Twit

    /**
     * reads secrets from json file, initializes bot
     */
    public async init(): Promise<void> {
        try {
            this.secrets = JSON.parse(
                readFileSync("./secrets.json", {
                    flag: 'r',
                    encoding: 'utf-8'
                })
            );
    
            this.twitterClient =  new Twit({
                consumer_key: this.secrets.apiKey,
                consumer_secret: this.secrets.apiKeySecret,
                access_token: this.secrets.accessToken,
                access_token_secret: this.secrets.accessTokenSecret
            })
    
            const user = await this.twitterClient.get("users/lookup", {
                screen_name: this.jimmysTiwtterHandle
            })

            //todo: use proper type
            //@ts-expect-error
            this.jimmysUserId = user.data[0].id_str
        } catch(error) {
            this.log(`error during init() ${JSON.stringify(error)}`)
        }
    }

    /**
     * listens for new tweets, edits photo and replies
     */
    public async run(): Promise<void> {
        this.log(`init done, subbed to stream with userId ${this.jimmysUserId}`);

        const stream = this.twitterClient.stream('statuses/filter', {
            follow: this.jimmysUserId
        })

        stream.on('tweet', async lastTweet => {
            this.log(`new tweet: ${lastTweet.text} (${lastTweet.id_str})`)

            if(lastTweet.user.id_str !== this.jimmysUserId) {
                return;
            }

            const photos = lastTweet.entities.media?.filter((media: any) => media.type === 'photo');
            
            this.log( `${photos?.length || 0} photo(s) in new tweet (${lastTweet.id_str})`)

            for(const photo of photos || []) {
                try {
                    await this.downloadOriginalImage(photo);
                    const captionedPhoto = await this.addCaption();
                    await this.sendReply(captionedPhoto, lastTweet.id_str);
                } catch(error) {
                    this.log(`didn't manage to sexify photo ${JSON.stringify(photo)}. reason: ${JSON.stringify(error)}`)
                }
            }
        })     
    }

    /**
     * saves specfied media to local file system.
     * @param photo     media to download
     */
    private async downloadOriginalImage(photo: Twitter.MediaEntity): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const file = createWriteStream(this.originalImagePath)
                get(photo.media_url_https, response => {
                    response.pipe(file);
                
                    file.on("finish", () => {
                        this.log(`finished downloading og file`)
                        file.close()
                        resolve()
                    })
                })
            } catch(e) {
                this.log(`error during downloadOriginalImage(${JSON.stringify(photo)}): ${JSON.stringify(e)}`)
                reject(e)
            }
        })       
    }

    /**
     * adds caption to most recently downloaded photo.
     * @returns buffer containing the captioned photo
     */
    private async addCaption(): Promise<Buffer> {
        try {
            const browser = await Puppeteer.launch({
                args: ['--no-sandbox'],
            });
            const page = await browser.newPage();
            await page.goto(`file://${resolve('meme.html')}`, {
                waitUntil: "networkidle2"
            })
            
            let {width, height} = sizeOf(this.originalImagePath);
            
            if(width && height) {
                if(width > this.maxImageDimension || height > this.maxImageDimension) {
                    if(width >= height) {
                        height = Math.floor( height * (this.maxImageDimension / width) )
                        width = this.maxImageDimension
                    } else {
                        width = Math.floor( width * (this.maxImageDimension / height) );
                        height = this.maxImageDimension
                    }
                }
        
                await page.setViewport({
                    width: width + 100,
                    height: height + 100 + 120,
                })        
            }
            
            const screenshot = await page.screenshot({
                type: "jpeg",
                //saving it for good measure, not strictly necessary
                path: `${this.originalImagePath}-captioned.jpeg`,
                quality: 50,
                encoding: 'binary'
            }) as Buffer
    
            await browser.close()
    
            this.log("finished taking screenshot")
    
            return screenshot;
        } catch(error) {
            this.log(`error during addCaption(): ${JSON.stringify(error)}`);
            return Promise.reject(error);
        }
    }

    /**
     * @param captionedPhoto 
     * @returns id_str of the tweet the bot is replying to, e.g. the tweet from which the bot took the photo
     */
    private async sendReply(captionedPhoto: Buffer, replyingTo: string): Promise<string> {
        try {
            const uploadedMediaIdString = (await this.twitterClient.post("media/upload", {
                media_data: captionedPhoto.toString("base64")
                
                //@ts-expect-error
            })).data.media_id_string
    
            const reply = (await this.twitterClient.post(("statuses/update"), {
                in_reply_to_status_id: replyingTo,
                status: `@${this.jimmysTiwtterHandle}`,
                media_ids: [uploadedMediaIdString],
            }));
    
            //@ts-expect-error
            this.log(`sent reply (${reply.data.id_str}), replying to ${replyingTo}, media ids: ${JSON.stringify([uploadedMediaIdString])}`)
    
            this.twitterClient.post("statuses/retweet", {
                //@ts-expect-error
                id: reply.data.id_str
            })
    
            this.log(`retweeted own tweet`)
    
            //@ts-expect-error
            return reply.data.id_str
        } catch(error) {
            this.log(`error during sendReply(${replyingTo}): ${JSON.stringify(error)}`)
            return Promise.reject(error);
        }
    }

    /**
     * logs to console and log.txt file
     * @param event the 
     */
    private log(event: string): void {
        const logEntry = `[${new Date().toISOString()}] ${event}\n`;
        console.log(logEntry);
        appendFileSync('log.txt', logEntry);
    }
}

const bot = new JimmerSexBot();
await bot.init()
bot.run()


