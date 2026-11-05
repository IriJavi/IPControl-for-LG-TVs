# LGTVs-MSPe
This is a small repo maintained by Mario Jurado and I, to set the LG TVs in the line alive through IP Control. Normally LG TV models share the same software and hardware amongst all the 
user model types , such as  86QNED86A6A, 75QNED84A6C, 65NANO81A6. AEU, 55UA75006LA...




# HOW TO USE:
This piece of software is hardcoded specifically for the LG TVs on our company, but the same principle can be applied to any LG TV (User model).
The main contributors of this code suggest specifically to select in the TV Menu, the screensaver option by default to the maximum available, which is 30 minutes and then set-up the program.

It is necessary to set the IP Control active, as it will be the mean to communicate with the LG TVs. It is necessary to connect to the same subnet or allow your specific device into the same subnet.
In this case. Our subnet is 10.137.73.()


The source code is divided, and the main program is server.js, which will periodically assign any desired command available in the webOS wiki (https://www.home-assistant.io/integrations/webostv) that triggers the screen to recover (all the commands are available at commands.json), such as:
  { 
    "command": "ssap://tv/channelDown",
    "description": "Channel down"
  },

The .json archives contain the TVs data such as: IP / MAC Adress / Gateway subnet / Mask  which can be adapted. 

