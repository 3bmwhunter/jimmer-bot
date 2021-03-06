import { appendFileSync, createWriteStream, readFileSync } from "fs";
import { get } from "https";
import { resolve as pathResolve } from "path";

import Twit, {Twitter} from "twit";
import {Autohook} from "twitter-autohook"

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
    ngrokAuthToken: string;
}

enum BotCommands {
    DELETE = '!delete',
    STOP = '!stop'
}

class JimmerSexBot {
    /**
     * api keys for twitter bot
     */
    private secrets!: Secrets 

    /**
     * jimmy's twitter @ 
     */
    private readonly jimmysTwitterHandle = 'JimmyBroadbent'

    private readonly botsTwitterHandle = 'JimmerBot';
    
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

    private botsUserId = "";

    /**
     * twitter api client instance
     */
    private twitterClient!: Twit

    /**
     * if true, the bot will not respond to new tweets
     */
    private stopped = false;

    private readonly MILLISECONDS_IN_A_SECOND = 1000;
    private readonly SECONDS_IN_A_MINUTE = 60;
    private readonly BOT_ERROR_MESSAGE = "Sorry, I couldn't process your request"

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
    
            const jimmyUsers = (await this.twitterClient.get("users/lookup", {
                screen_name: this.jimmysTwitterHandle
            })).data as unknown as Twitter.User[]
            
            this.jimmysUserId = jimmyUsers[0].id_str

            const botUsers = (await this.twitterClient.get("users/lookup", {
                screen_name: this.botsTwitterHandle
            })).data as unknown as Twitter.User[];

            this.botsUserId = botUsers[0].id_str;

            this.log(`init done, subbed to stream with userId ${this.jimmysUserId}`);
        } catch(error) {
            this.log(`error during init() ${error}`)
        }
    }

    /**
     * listens for new tweets, edits photo and replies
     */
    public async run(): Promise<void> {
        //tweets by the man himself
        const jimmyTweetStream = this.twitterClient.stream('statuses/filter', {
            follow: this.jimmysUserId
        })

        jimmyTweetStream.on('tweet', async (lastTweet: Twitter.Status) => {
            if(!this.stopped) {
                if(lastTweet.user.id_str !== this.jimmysUserId) {
                    return;
                }
    
                this.log(`new tweet: ${lastTweet.text} (${lastTweet.id_str})`)
    
                this.captionTweet(lastTweet.id_str)
            }
        })     

        const webhook = new Autohook({
            token: this.secrets.accessToken,
            token_secret: this.secrets.accessTokenSecret,
            consumer_key: this.secrets.apiKey,
            consumer_secret: this.secrets.apiKeySecret,
            env: 'dev',
            ngrok_secret: this.secrets.ngrokAuthToken
        });

        await webhook.removeWebhooks();

        webhook.on('event' ,event => {
            this.handleHookEvent(event)
        })

        await webhook.start();

        this.log('started webhook')

        await webhook.subscribe({
            oauth_token: this.secrets.accessToken,
            oauth_token_secret: this.secrets.accessTokenSecret,
        })

        this.log('subbed to webhook')
    }

    private async captionTweet(tweetId: string, triggeredByUserName?: string, inReplyTo?: string, retweet = true): Promise<void> {
        const replyingToHandle = triggeredByUserName || this.jimmysTwitterHandle;

        const photos = await this.getAllPhotos(tweetId);
                
        this.log(`${photos?.length || 0} photo(s) in new tweet (${tweetId})`)

        for(const photo of photos || []) {
            try {
                await this.downloadOriginalImage(photo);
                const captionedPhoto = await this.addCaption();
                await this.sendReply(captionedPhoto, inReplyTo || tweetId, replyingToHandle, retweet);
            } catch(error) {
                this.log(`didn't manage to sexify photo ${JSON.stringify(photo)}. reason: ${error}`)
            }
        }
    }

    private async handleHookEvent(event: any): Promise<void> {
        if(event.direct_message_events) {
            this.handleDirectMessage(event)
        }

        if(event.tweet_create_events) {
            if(!this.stopped) {

                const commandTweet = await this.getTweet(event.tweet_create_events[0].id_str);
                
                const text = commandTweet.full_text?.toLowerCase();

                //only respond if bot was told to
                if(!text?.includes(`@${this.botsTwitterHandle}`.toLocaleLowerCase())) {
                    return;
                }

                if(!text.includes('caption')) {
                    return;
                }

                //get the tweet to be captioned
                const originalTweetId = commandTweet.in_reply_to_status_id_str;
                
                if(!originalTweetId) {
                    return;
                }

                this.log(`responding to caption command on tweet ${originalTweetId} because of command tweet ${commandTweet.id_str}`)

                this.captionTweet(originalTweetId, commandTweet.user.screen_name, commandTweet.id_str, false);
            }
        }
    }


    /**
     * handles incoming dm.
     * attempts to parse and execute command if message was sent by jimmy
     */
    private async handleDirectMessage(event: any): Promise<void> {
        if(!event.direct_message_events) {
            return;
        }

        if(event.direct_message_events[0]?.message_create.sender_id !== this.jimmysUserId) {
            return;
        }

        const messageText = event.direct_message_events[0].message_create.message_data.text || '';

        this.log(`new dm: ${messageText}`);

        let responseMessage = '';
        if(messageText.includes(BotCommands.STOP)) {
            try {
                const amount = parseInt(messageText.split(BotCommands.STOP)[1]);
                if(this.timeout) {
                    responseMessage += 'Cleared previous timeout, ';
                }

                const backDate = this.timeOut(amount);
                responseMessage += `Bot will resume posting at ${backDate.toISOString()} (That's UTC)`;
            } catch {
                responseMessage += this.BOT_ERROR_MESSAGE;
            }
            
        } else if(messageText.includes(BotCommands.DELETE)) {
            try {
                const id = messageText.split(BotCommands.DELETE)[1];

                await this.twitterClient.post("statuses/destroy", {
                    id
                });

                responseMessage += "Successfully deleted";
            } catch {
                responseMessage += this.BOT_ERROR_MESSAGE;
            }
        }

        if(!responseMessage) {
            return;
        }

        await this.twitterClient.post("direct_messages/events/new", {
            //@ts-expect-error
            event: {
                type: 'message_create',
                message_create: {
                    target: {
                        recipient_id: this.jimmysUserId,
                    },
                    message_data: {
                        text: responseMessage
                    }
                }
            }
        })

        this.log(`responded to dm '${messageText}' with '${responseMessage}'`)
    }

    private timeout?: NodeJS.Timeout;

    /**
     * @param amount in minutes
     */
    private timeOut(amount: number): Date {
        this.stopped = true;

        if(this.timeout) {
            clearTimeout(this.timeout)
        }

        const amountInMilliSeocnds = amount * this.MILLISECONDS_IN_A_SECOND * this.SECONDS_IN_A_MINUTE
        this.timeout = setTimeout(() => {
            this.stopped = false;
        }, amountInMilliSeocnds)

        const date = new Date()
        date.setTime(date.getTime() + amountInMilliSeocnds)
        return date;
    }

    private async getTweet(id: string): Promise<Twitter.Status> {
        return (await this.twitterClient.get("statuses/show", {
            id,
            tweet_mode: 'extended'
        })).data as unknown as Twitter.Status;
    }

    /**
     * @param tweetId 
     * @returns all media entities with type 'photo' in status with tweetId
     */
    public async getAllPhotos(tweetId: string): Promise<Twitter.MediaEntity[]> {
        const tweet = await this.getTweet(tweetId);
        return tweet.extended_entities?.media.filter(media => media.type === 'photo') || []
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
            await page.goto(`file://${pathResolve('meme.html')}`, {
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
            this.log(`error during addCaption(): ${error}`);
            return Promise.reject(error);
        }
    }

    /**
     * @param captionedPhoto 
     * @returns id_str of the tweet the bot is replying to, e.g. the tweet from which the bot took the photo
     */
    private async sendReply(captionedPhoto: Buffer, replyingToId: string, replyingToHandle: string, retweet = true): Promise<string> {
        try {
            const uploadedMediaIdString = ((await this.twitterClient.post("media/upload", {
                media_data: captionedPhoto.toString("base64")
            })).data as any).media_id_string
    
            const reply = (await this.twitterClient.post(("statuses/update"), {
                in_reply_to_status_id: replyingToId,
                status: `@${replyingToHandle}`,
                media_ids: [uploadedMediaIdString],
            })).data as unknown as Twitter.Status;
    
            this.log(`sent reply (${reply.id_str}), replying to ${replyingToId}, media ids: ${JSON.stringify([uploadedMediaIdString])}`)
    
            if(retweet) {
                this.twitterClient.post("statuses/retweet", {
                    id: reply.id_str
                })
        
                this.log(`retweeted own tweet`)
            }
    
            return reply.id_str
        } catch(error) {
            this.log(`error during sendReply(${replyingToId}): ${error}`)
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


