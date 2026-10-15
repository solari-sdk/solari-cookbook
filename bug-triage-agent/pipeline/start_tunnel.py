from pyngrok import ngrok
import time

url = ngrok.connect(5000).public_url
print(url)

while True:
    time.sleep(60)